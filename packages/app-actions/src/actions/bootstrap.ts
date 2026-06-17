// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Server-level actions: one-time bootstrap (shared Traefik proxy + inventory),
 * explicit proxy repair, and the full server purge.
 */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { InstanceMode } from '@shm/schemas';
import { DEFAULT_PROXY_NETWORK, composeCommands } from '@shm/docker';
import {
  assertSafeToBootstrap,
  assessBootstrapTarget,
  buildServerBootstrap,
  type BootstrapTargetFacts,
} from '@shm/core';
import {
  InventoryStore,
  ManifestStore,
  instancePaths,
  instancesDir,
  proxyDir,
  serverInventoryPath,
  writeFileAtomic,
} from '@shm/instances';
import {
  ensureProxyRunning,
  errMessage,
  looksLikeInstanceState,
  pathExists,
  type ActionDeps,
} from './shared.js';
import { instanceRemove } from './lifecycle.js';

// ---------------------------------------------------------------------------
// server init
// ---------------------------------------------------------------------------

export interface ServerInitOptions {
  serverId: string;
  mode: InstanceMode;
  letsencryptEmail?: string;
  proxyNetwork?: string;
  /** Acknowledge import/repair of an already-bootstrapped or partial target. */
  allowImport?: boolean;
  /**
   * Wizard retry/resume: the instance id the caller is about to (re)install.
   * A failed first attempt leaves the target half-bootstrapped (inventory /
   * proxy compose / instance dir on disk), and the wizard's in-memory "retry"
   * acknowledgement is lost when the manager restarts (e.g. the operator
   * pulled an updated image before retrying). When the target's existing
   * state is just that — no instances yet, or only THIS instance — re-running
   * the bootstrap is a safe continuation, so it proceeds as an import instead
   * of failing with "already bootstrapped". A target with OTHER instances
   * still refuses without an explicit {@link allowImport}.
   */
  resumeInstanceId?: string;
}

async function listInstanceDirs(root: string): Promise<string[]> {
  const names = await readdir(instancesDir(root), { withFileTypes: true })
    .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
    .catch(() => [] as string[]);
  // Folders holding ONLY retained backups (what full_delete / server purge
  // leave behind on purpose) are not instances and must not block a fresh
  // bootstrap — same rule instanceList applies before reporting `broken`.
  const real: string[] = [];
  for (const name of names) {
    if (await looksLikeInstanceState(instancePaths(name, root))) real.push(name);
  }
  return real;
}

/** Filesystem-level bootstrap target discovery (Docker-label scan is optional). */
async function discoverBootstrapTarget(root: string): Promise<BootstrapTargetFacts> {
  return {
    inventoryExists: await pathExists(serverInventoryPath(root)),
    proxyComposeExists: await pathExists(`${proxyDir(root)}/compose.yaml`),
    instanceDirsOnDisk: await listInstanceDirs(root),
  };
}

export async function serverInit(deps: ActionDeps, opts: ServerInitOptions): Promise<{ proxyComposePath: string; inventoryPath: string }> {
  // Never overwrite an already-managed or partial/foreign install unless the
  // operator explicitly acknowledges import/repair — or this is a safe
  // continuation of a half-finished bootstrap of the SAME instance (see
  // ServerInitOptions.resumeInstanceId).
  const facts = await discoverBootstrapTarget(deps.root);
  const resumable =
    opts.resumeInstanceId !== undefined &&
    (facts.instanceDirsOnDisk.length === 0 ||
      facts.instanceDirsOnDisk.every((dir) => dir === opts.resumeInstanceId));
  assertSafeToBootstrap(assessBootstrapTarget(facts), {
    allowImport: (opts.allowImport ?? false) || resumable,
  });

  const boot = buildServerBootstrap({
    serverId: opts.serverId,
    managerVersion: deps.managerVersion,
    mode: opts.mode,
    root: deps.root,
    ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
    ...(opts.letsencryptEmail ? { letsencryptEmail: opts.letsencryptEmail } : {}),
    ...(opts.proxyNetwork ? { proxyNetwork: opts.proxyNetwork } : {}),
  });
  await writeFileAtomic(boot.proxyComposePath, boot.proxyComposeYaml);
  const store = new InventoryStore(deps.root);
  // Import/repair must never orphan already-registered instances: a fresh
  // bootstrap inventory starts empty, so carry the existing entries over.
  const existing = await store.read().catch(() => null);
  await store.write(existing ? { ...boot.inventory, instances: existing.instances } : boot.inventory);

  // Every instance compose references the shared proxy network as `external`,
  // so bootstrap must guarantee it exists — otherwise the very first
  // `instance install --up` fails with "network … declared as external, but
  // could not be found". In production the shared Traefik proxy is started
  // here too; local mode routes via published ports and needs no proxy
  // container (and must not grab 80/443 on a dev machine).
  await deps.ensureNetwork?.(boot.inventory.proxy.network);
  if (opts.mode === 'production') {
    await deps.runner.run(proxyDir(deps.root), composeCommands.upDetached());
  }
  return { proxyComposePath: boot.proxyComposePath, inventoryPath: store.path };
}

/**
 * Explicit operator repair: ensure the shared production proxy is running. Reads
 * the server's mode from any installed instance manifest (the inventory does not
 * record server mode); defaults to production when at least one instance is
 * production, so a server bootstrapped with a domain always re-starts its proxy.
 */
export async function serverStartProxy(deps: ActionDeps): Promise<{ started: boolean; network: string }> {
  const inventory = await new InventoryStore(deps.root).read();
  let production = false;
  for (const entry of inventory.instances) {
    const manifest = await new ManifestStore(entry.instanceId, deps.root).read().catch(() => null);
    if (manifest?.mode === 'production') {
      production = true;
      break;
    }
  }
  await ensureProxyRunning(deps, production ? 'production' : 'local');
  return { started: production, network: inventory.proxy.network };
}

// ---------------------------------------------------------------------------
// server purge (remove EVERYTHING this manager created)
// ---------------------------------------------------------------------------

export interface ServerPurgeOptions {
  /** Must equal `purge selfhelp`. */
  confirm?: string;
  /** Also delete every instance's backups (default: keep them). */
  deleteBackups?: boolean;
}

export interface ServerPurgeReport {
  ok: boolean;
  errors: string[];
  instancesRemoved: string[];
  proxyRemoved: boolean;
  networkRemoved: boolean;
  /** State files/dirs deleted under the root. */
  removedPaths: string[];
  /** Paths intentionally preserved (backups unless --delete-backups). */
  keptPaths: string[];
}

/**
 * Full teardown of a SelfHelp server: every instance (containers + volumes +
 * folders), the shared Traefik proxy, the proxy network, and the manager's
 * server state files. The ONE deliberately destructive command — it demands
 * the typed confirmation `purge selfhelp` and still keeps per-instance
 * backups unless `--delete-backups` is passed. After a purge, `server init`
 * starts from a clean slate.
 */
export async function serverPurge(deps: ActionDeps, opts: ServerPurgeOptions): Promise<ServerPurgeReport> {
  const report: ServerPurgeReport = {
    ok: false,
    errors: [],
    instancesRemoved: [],
    proxyRemoved: false,
    networkRemoved: false,
    removedPaths: [],
    keptPaths: [],
  };
  if (opts.confirm !== 'purge selfhelp') {
    report.errors.push('Confirmation mismatch: pass --confirm "purge selfhelp" to proceed.');
    return report;
  }

  const inventoryStore = new InventoryStore(deps.root);
  const inventory = await inventoryStore.read().catch(() => null);

  // 1. Every registered instance: full delete (containers, volumes, folder).
  for (const entry of inventory?.instances ?? []) {
    try {
      const res = await instanceRemove(deps, entry.instanceId, {
        mode: 'full_delete',
        deleteVolumes: true,
        deleteBackups: opts.deleteBackups ?? false,
        confirm: `delete ${entry.instanceId}`,
      });
      if (!res.executed) {
        report.errors.push(`${entry.instanceId}: ${res.errors.join('; ')}`);
        continue;
      }
      report.instancesRemoved.push(entry.instanceId);
      if (!(opts.deleteBackups ?? false)) {
        report.keptPaths.push(instancePaths(entry.instanceId, deps.root).backupsDir);
      }
    } catch (err) {
      report.errors.push(`${entry.instanceId}: ${errMessage(err)}`);
    }
  }

  // 2. Shared proxy: compose down (Traefik holds no instance data), then the
  //    proxy folder and network.
  const proxy = proxyDir(deps.root);
  try {
    if (await pathExists(path.join(proxy, 'compose.yaml'))) {
      await deps.runner.run(proxy, composeCommands.down());
      report.proxyRemoved = true;
    }
    await rm(proxy, { recursive: true, force: true });
    report.removedPaths.push(proxy);
  } catch (err) {
    report.errors.push(`proxy: ${errMessage(err)}`);
  }
  const network = inventory?.proxy.network ?? DEFAULT_PROXY_NETWORK;
  if (deps.removeNetwork) {
    try {
      await deps.removeNetwork(network);
      report.networkRemoved = true;
    } catch (err) {
      report.errors.push(`network ${network}: ${errMessage(err)}`);
    }
  }

  // 3. Server state files. The instances/ tree stays when backups are kept.
  for (const rel of ['selfhelp.server.json', 'selfhelp.server.json.bak']) {
    const file = path.join(deps.root, rel);
    if (await pathExists(file)) {
      await rm(file, { force: true });
      report.removedPaths.push(file);
    }
  }
  if (opts.deleteBackups ?? false) {
    const instances = path.join(deps.root, 'instances');
    await rm(instances, { recursive: true, force: true });
    report.removedPaths.push(instances);
  }

  // 4. Manager state: operators, operation journal, locks, poller state — a
  //    purged server starts over at the first-run setup. The audit log is the
  //    one record deliberately kept (the purge itself should stay traceable).
  const managerDir = path.join(deps.root, 'manager');
  if (await pathExists(managerDir)) {
    const auditFile = path.join(managerDir, 'audit.jsonl');
    const keepAudit = await pathExists(auditFile);
    for (const entry of await readdir(managerDir).catch(() => [] as string[])) {
      if (keepAudit && entry === 'audit.jsonl') continue;
      await rm(path.join(managerDir, entry), { recursive: true, force: true });
      report.removedPaths.push(path.join(managerDir, entry));
    }
    if (keepAudit) report.keptPaths.push(auditFile);
  }

  report.ok = report.errors.length === 0;
  return report;
}
