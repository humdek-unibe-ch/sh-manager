// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Web UI composition root, callable from both entrypoints:
 * `sh-manager-web` (apps/web/src/bin.ts) and `sh-manager web` (the CLI
 * subcommand — the route used when the manager runs from its Docker image).
 *
 * Wires the real {@link BootstrapActions} to the existing, tested CLI actions
 * (`doctor`, `serverInit`, `instanceInstall`) and the registry client
 * (signature verification), then serves the localhost-only wizard/console.
 * The testable logic lives in `wizard.ts` + `server.ts`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MANAGER_VERSION } from '@shm/schemas';
import { RegistryClient, RegistryError } from '@shm/registry';
import { discoverEngineRoot } from '@shm/docker';
import { FileOperatorStore, isBootstrapRequired } from '@shm/auth';
import { provisionFailureDetail, type BootstrapActions } from './actions.js';
import { browseUrl, createBootstrapServer, type ServerMode } from './server.js';
import { AuditLog, InstanceLocks, OperationJournal, OperationRunner } from './jobs.js';
import { buildInstanceActions } from './instances.js';
import { CmsOperationsPoller } from './poller.js';
import { doctor, instanceInstall, serverInit } from '../../cli/src/actions.js';
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
  mode?: ServerMode;
  allowNonLocal?: boolean;
  persistAfterBootstrap?: boolean;
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
  // Mode default is AUTO: once the server inventory exists, the web UI is the
  // authenticated operations console (persistent); a fresh state folder gets
  // the one-shot install wizard (bootstrap). An explicit --mode / SHM_WEB_MODE
  // always wins.
  const envMode = process.env.SHM_WEB_MODE;
  const requestedMode: ServerMode | undefined =
    opts.mode ?? (envMode === 'bootstrap' || envMode === 'persistent' ? envMode : undefined);
  const serverInitialized = existsSync(path.join(root, 'selfhelp.server.json'));
  const mode: ServerMode = requestedMode ?? (serverInitialized ? 'persistent' : 'bootstrap');
  const allowNonLocal = opts.allowNonLocal ?? process.env.SHM_WEB_ALLOW_NONLOCAL === 'true';
  const persistAfterBootstrap = opts.persistAfterBootstrap ?? process.env.SHM_WEB_PERSIST === 'true';
  const clientDir = opts.clientDir ?? process.env.SHM_WEB_CLIENT_DIR ?? path.join(here, '..', 'dist-web');
  // Same default trust anchor as the CLI: the pinned official production key,
  // never the dev fixture (its seed is public).
  const trustedKeysPath =
    opts.trustedKeysPath ??
    process.env.SELFHELP_TRUSTED_KEYS ??
    path.join(here, '..', '..', '..', 'packages', 'schemas', 'keys', 'official-trusted-keys.json');
  const managerVersion = opts.managerVersion ?? process.env.SHM_MANAGER_VERSION ?? MANAGER_VERSION;

  const trustedKeys = await loadTrustedKeys(trustedKeysPath);
  // Same engine-path discovery as the CLI: the wizard's install must emit
  // engine-side bind sources when the manager runs containerized with the
  // state root mounted at a different path (Docker Desktop / Windows).
  const mapping = await discoverEngineRoot({ root });
  const deps = realDeps(root, trustedKeys, mapping ? { engineRoot: mapping.engineRoot } : {});

  let lastHealthOk = false;

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
    async runInstall(plan) {
      const publicUrl =
        plan.instanceInstall.mode === 'production'
          ? `https://${plan.instanceInstall.domain}`
          : `http://localhost:${plan.instanceInstall.localPort}`;
      // Failures come back as a structured outcome (never a thrown 500): the
      // wizard records them, shows the failing phase, and can offer a retry.
      try {
        // resumeInstanceId: a failed attempt leaves the server half-bootstrapped,
        // and the wizard's in-memory retry acknowledgement does not survive a
        // manager restart (operator updates the image, then reinstalls). When
        // the on-disk state holds no OTHER instance, re-running the bootstrap
        // for the same install is a safe continuation, not a conflict.
        await serverInit(deps, { ...plan.serverInit, resumeInstanceId: plan.instanceInstall.instanceId });
      } catch (err) {
        lastHealthOk = false;
        return { ok: false, publicUrl, failedStep: 'server_init', detail: err instanceof Error ? err.message : String(err) };
      }
      let res;
      try {
        res = await instanceInstall(deps, { ...plan.instanceInstall });
      } catch (err) {
        lastHealthOk = false;
        return { ok: false, publicUrl, failedStep: 'install', detail: err instanceof Error ? err.message : String(err) };
      }
      lastHealthOk = res.provision ? res.provision.ok : res.broughtUp;
      // The generated admin password rides ONLY on this one-shot outcome (and
      // is persisted server-side to the instance's secrets/admin_password):
      // it never enters the wizard state or any /api/state snapshot. It is
      // included on failure outcomes too — provisioning may have created the
      // admin before a later step (e.g. health) stopped the install.
      const adminSecret = {
        ...(res.adminPassword ? { adminPassword: res.adminPassword } : {}),
        ...(res.adminPasswordFile ? { adminPasswordFile: res.adminPasswordFile } : {}),
      };
      if (res.provision && !res.provision.ok) {
        const failed = res.provision.steps.find((s) => s.status === 'failed');
        return {
          ok: false,
          instanceDir: res.instanceDir,
          version: res.version,
          publicUrl,
          detail: provisionFailureDetail(res.provision.steps),
          ...(failed ? { failedStep: failed.name } : {}),
          ...adminSecret,
        };
      }
      return {
        ok: true,
        instanceDir: res.instanceDir,
        version: res.version,
        publicUrl,
        detail: res.provision ? 'Provisioning succeeded.' : 'Installed.',
        ...adminSecret,
      };
    },
    async checkHealth() {
      // Health was executed as the final provisioning step during runInstall.
      return { healthy: lastHealthOk, degraded: false, detail: lastHealthOk ? 'All services healthy.' : 'Health check failed during provisioning.' };
    },
    async checkManagerUpdate() {
      return checkSelfUpdate({ currentVersion: managerVersion });
    },
    async listVersions(registryUrl, channel) {
      const client = new RegistryClient({ baseUrl: registryUrl, trustedKeys, managerVersion });
      try {
        const index = await client.getIndex();
        const versions = [...new Set(index.core.filter((r) => r.channel === channel && !r.blocked).map((r) => r.version))]
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        return { versions };
      } catch (err) {
        return { versions: [], detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const operatorStore = mode === 'persistent' ? new FileOperatorStore(path.join(root, 'manager', 'operators.json')) : undefined;

  // Instance lifecycle management + the background CMS-operations poller exist
  // ONLY in persistent mode (authenticated, CSRF-protected). Bootstrap mode
  // never exposes them and never drains CMS operations.
  let instanceManagement: Parameters<typeof createBootstrapServer>[0]['instanceManagement'];
  let poller: CmsOperationsPoller | undefined;
  if (mode === 'persistent') {
    const journal = new OperationJournal(root);
    const audit = new AuditLog(root);
    const locks = new InstanceLocks(root);
    const runner = new OperationRunner(journal, audit, locks);
    const instances = buildInstanceActions({ deps, locks });
    instanceManagement = { instances, runner, journal };

    const pollSeconds = Number(process.env.SHM_CMS_POLL_SECONDS ?? '15');
    if (Number.isFinite(pollSeconds) && pollSeconds > 0) {
      poller = new CmsOperationsPoller({ instances, runner, intervalMs: pollSeconds * 1000 });
    }
  }

  const handle = createBootstrapServer({
    actions,
    mode,
    host,
    port,
    allowNonLocal,
    persistAfterBootstrap,
    clientDir,
    managerVersion,
    ...(operatorStore ? { operatorStore } : {}),
    ...(instanceManagement ? { instanceManagement } : {}),
  });

  const bound = await handle.listen();
  poller?.start();
  // Always print the URL an operator can actually open: a wildcard bind
  // (in-container) is reachable via the published localhost port, not 0.0.0.0.
  console.log(`SelfHelp Manager ${mode} UI (v${managerVersion}): ${browseUrl(bound.host, bound.port)}`);
  if (requestedMode === undefined) {
    console.log(
      serverInitialized
        ? 'Mode auto-selected: persistent (server inventory found) — sign in to manage instances. Force the installer with --mode bootstrap.'
        : 'Mode auto-selected: bootstrap (fresh state folder) — the install wizard will run. After the first install, the web UI starts as the management console.',
    );
  }
  if (mode === 'persistent' && operatorStore && isBootstrapRequired(await operatorStore.load())) {
    console.log(
      'No operator accounts exist yet, so sign-in is not possible. Create the first operator:\n' +
        '  sh-manager admin create --email you@example.org --roles server_owner\n' +
        '  (wrapper: ./shm.sh admin create ...  |  .\\shm.ps1 admin create ...)',
    );
  }
  if (bound.host === '0.0.0.0' || bound.host === '::') {
    console.log('Reachable only through the published port (the shm wrapper publishes it on 127.0.0.1).');
  } else if (!allowNonLocal) {
    console.log('Bound to localhost only. Use an SSH tunnel for remote access.');
  }
  return bound;
}
