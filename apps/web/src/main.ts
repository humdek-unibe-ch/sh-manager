// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Web UI composition root, callable from both entrypoints:
 * `sh-manager-web` (apps/web/src/bin.ts) and `sh-manager web` (the CLI
 * subcommand — the route used when the manager runs from its Docker image).
 *
 * There is ONE web UI: the authenticated operations console. A fresh state
 * root offers the first-run operator setup, and the create-instance wizard
 * bootstraps the server (proxy + inventory) with the first install. Wires the
 * real check/instance actions to the existing, tested CLI actions and the
 * registry client (signature verification), then serves the localhost-only
 * console. The testable logic lives in `server.ts` + `instances.ts`.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MANAGER_VERSION } from '@shm/schemas';
import { RegistryClient, RegistryError } from '@shm/registry';
import { discoverEngineRoot } from '@shm/docker';
import { FileOperatorStore, isBootstrapRequired } from '@shm/auth';
import type { BootstrapActions } from './actions.js';
import { browseUrl, createManagerServer, DEFAULT_REGISTRY_URL } from './server.js';
import { AuditLog, InstanceLocks, OperationJournal, OperationRunner } from './jobs.js';
import { buildInstanceActions } from './instances.js';
import { CmsOperationsPoller } from './poller.js';
import { BackupSchedulerLoop } from './backup-scheduler.js';
import { doctor } from '../../cli/src/actions.js';
import { loadTrustedKeys, realDeps } from '../../cli/src/env.js';
import { checkSelfUpdate } from '../../cli/src/self-update.js';

const execFileAsync = promisify(execFile);

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}
async function dockerComposeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['compose', 'version']);
    return true;
  } catch {
    return false;
  }
}

export interface WebUiOptions {
  root?: string;
  host?: string;
  port?: number;
  allowNonLocal?: boolean;
  clientDir?: string;
  trustedKeysPath?: string;
  managerVersion?: string;
}

/** Start the manager web UI; resolves once it is listening. */
export async function startWebUi(opts: WebUiOptions = {}): Promise<{ host: string; port: number }> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = opts.root ?? process.env.SELFHELP_ROOT ?? '/opt/selfhelp';
  const host = opts.host ?? process.env.SHM_WEB_HOST ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.SHM_WEB_PORT ?? '8765');
  const allowNonLocal = opts.allowNonLocal ?? process.env.SHM_WEB_ALLOW_NONLOCAL === 'true';
  const clientDir = opts.clientDir ?? process.env.SHM_WEB_CLIENT_DIR ?? path.join(here, '..', 'dist-web');
  // Same default trust anchor as the CLI: the pinned official production key,
  // never the dev fixture (its seed is public).
  const trustedKeysPath =
    opts.trustedKeysPath ??
    process.env.SELFHELP_TRUSTED_KEYS ??
    path.join(here, '..', '..', '..', 'packages', 'schemas', 'keys', 'official-trusted-keys.json');
  const managerVersion = opts.managerVersion ?? process.env.SHM_MANAGER_VERSION ?? MANAGER_VERSION;
  const defaultRegistryUrl = process.env.SELFHELP_REGISTRY ?? DEFAULT_REGISTRY_URL;

  const trustedKeys = await loadTrustedKeys(trustedKeysPath);
  // Same engine-path discovery as the CLI: installs must emit engine-side bind
  // sources when the manager runs containerized with the state root mounted at
  // a different path (Docker Desktop / Windows).
  const mapping = await discoverEngineRoot({ root });
  const deps = realDeps(root, trustedKeys, mapping ? { engineRoot: mapping.engineRoot } : {});

  const actions: BootstrapActions = {
    async checkDocker() {
      const [d, c] = await Promise.all([dockerAvailable(), dockerComposeAvailable()]);
      return { dockerAvailable: d, dockerComposeAvailable: c };
    },
    async checkInternet() {
      try {
        const res = await fetch('https://github.com', { method: 'HEAD' });
        return res.ok || res.status < 500
          ? { ok: true, severity: 'ok' as const, detail: 'Outbound HTTPS reachable.' }
          : { ok: false, severity: 'error' as const, detail: `Unexpected status ${res.status}.` };
      } catch (err) {
        return { ok: false, severity: 'error' as const, detail: `No outbound HTTPS: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    async checkRegistry(registryUrl) {
      const client = new RegistryClient({ baseUrl: registryUrl, trustedKeys, managerVersion });
      try {
        const index = await client.getIndex();
        const coreRef = index.core[0];
        if (!coreRef) return { ok: true, signatureVerified: false, detail: 'Registry reachable but has no core releases.' };
        await client.getCoreRelease(coreRef);
        return { ok: true, signatureVerified: true, detail: 'Registry reachable and official signature verified.' };
      } catch (err) {
        if (err instanceof RegistryError) {
          if (err.code === 'signature_invalid') return { ok: true, signatureVerified: false, detail: err.message };
          return { ok: false, signatureVerified: false, detail: err.message };
        }
        return { ok: false, signatureVerified: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
    async checkResources(requiredPorts) {
      const result = await doctor(deps, requiredPorts);
      return { status: result.status === 'blocked' ? 'blocked' : result.status === 'warning' ? 'warning' : 'ok', detail: result.checks.map((c) => c.message).join(' ') };
    },
    async checkManagerUpdate() {
      return checkSelfUpdate({ currentVersion: managerVersion });
    },
    async listVersions(registryUrl, channel, kind = 'core') {
      const client = new RegistryClient({ baseUrl: registryUrl, trustedKeys, managerVersion });
      try {
        const index = await client.getIndex();
        const feed = kind === 'frontend' ? index.frontend : index.core;
        const versions = [...new Set(feed.filter((r) => r.channel === channel && !r.blocked).map((r) => r.version))]
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        return { versions };
      } catch (err) {
        return { versions: [], detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const operatorStore = new FileOperatorStore(path.join(root, 'manager', 'operators.json'));

  const journal = new OperationJournal(root);
  const interrupted = await journal.recoverInterrupted();
  if (interrupted > 0) {
    console.warn(`Marked ${interrupted} operation(s) left running by a previous process as failed.`);
  }
  const audit = new AuditLog(root);
  const locks = new InstanceLocks(root);
  const runner = new OperationRunner(journal, audit, locks);
  const instances = buildInstanceActions({ deps, locks });

  let poller: CmsOperationsPoller | undefined;
  const pollSeconds = Number(process.env.SHM_CMS_POLL_SECONDS ?? '15');
  if (Number.isFinite(pollSeconds) && pollSeconds > 0) {
    poller = new CmsOperationsPoller({ instances, runner, intervalMs: pollSeconds * 1000 });
  }

  // Nightly scheduled backups + GFS retention. `SHM_BACKUP_SCHEDULER=0`
  // disables the in-process loop (e.g. when a cron/systemd timer runs
  // `sh-manager server run-scheduled-backups` instead).
  let backupScheduler: BackupSchedulerLoop | undefined;
  if (process.env.SHM_BACKUP_SCHEDULER !== '0') {
    backupScheduler = new BackupSchedulerLoop({ instances, runner });
  }

  const handle = createManagerServer({
    actions,
    host,
    port,
    allowNonLocal,
    clientDir,
    managerVersion,
    defaultRegistryUrl,
    operatorStore,
    instanceManagement: { instances, runner, journal },
  });

  const bound = await handle.listen();
  poller?.start();
  backupScheduler?.start();
  // Always print the URL an operator can actually open: a wildcard bind
  // (in-container) is reachable via the published localhost port, not 0.0.0.0.
  console.log(`SelfHelp Manager console (v${managerVersion}): ${browseUrl(bound.host, bound.port)}`);
  const serverStatus = await instances.serverStatus();
  if (!serverStatus.initialized) {
    console.log('Fresh state folder: the console will guide you through creating the first instance.');
  } else {
    console.log(`Managing ${serverStatus.instanceCount} instance(s) on server ${serverStatus.serverId}.`);
  }
  if (isBootstrapRequired(await operatorStore.load())) {
    console.log(
      'No operator accounts exist yet. Open the console to create the first operator account\n' +
        '(or use the CLI: sh-manager admin create --email you@example.org --roles server_owner).',
    );
  }
  if (bound.host === '0.0.0.0' || bound.host === '::') {
    console.log('Reachable only through the published port (the shm wrapper publishes it on 127.0.0.1).');
  } else if (!allowNonLocal) {
    console.log('Bound to localhost only. Use an SSH tunnel for remote access.');
  }
  return bound;
}
