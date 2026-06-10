#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * SelfHelp Manager web entrypoint (`sh-manager-web`).
 *
 * Composition root: wires the real {@link BootstrapActions} to the existing,
 * tested CLI actions (`doctor`, `serverInit`, `instanceInstall`) and the
 * registry client (signature verification), then serves the localhost-only
 * bootstrap wizard. This file is the untyped-side glue — the testable logic
 * lives in `wizard.ts` + `server.ts`.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RegistryClient, RegistryError } from '@shm/registry';
import { FileOperatorStore } from '@shm/auth';
import type { BootstrapActions } from './actions.js';
import { createBootstrapServer, type ServerMode } from './server.js';
import { doctor, instanceInstall, serverInit } from '../../cli/src/actions.js';
import { loadTrustedKeys, realDeps } from '../../cli/src/env.js';

const execFileAsync = promisify(execFile);

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

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

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = arg('root', process.env.SELFHELP_ROOT) ?? '/opt/selfhelp';
  const host = arg('host', process.env.SHM_WEB_HOST) ?? '127.0.0.1';
  const port = Number(arg('port', process.env.SHM_WEB_PORT) ?? '8765');
  const mode = (arg('mode', process.env.SHM_WEB_MODE) ?? 'bootstrap') as ServerMode;
  const allowNonLocal = flag('allow-non-local') || process.env.SHM_WEB_ALLOW_NONLOCAL === 'true';
  const persistAfterBootstrap = flag('persist') || process.env.SHM_WEB_PERSIST === 'true';
  const clientDir = arg('client-dir', process.env.SHM_WEB_CLIENT_DIR) ?? path.join(here, '..', 'dist-web');
  const trustedKeysPath =
    arg('trusted-keys', process.env.SELFHELP_TRUSTED_KEYS) ??
    path.join(here, '..', '..', '..', 'packages', 'schemas', 'examples', 'trusted-keys.json');
  const managerVersion = process.env.SHM_MANAGER_VERSION ?? '0.1.1';

  const trustedKeys = await loadTrustedKeys(trustedKeysPath);
  const deps = realDeps(root, trustedKeys);

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
      await serverInit(deps, plan.serverInit);
      const res = await instanceInstall(deps, { ...plan.instanceInstall });
      lastHealthOk = res.provision ? res.provision.ok : res.broughtUp;
      const publicUrl =
        plan.instanceInstall.mode === 'production'
          ? `https://${plan.instanceInstall.domain}`
          : `http://localhost:${plan.instanceInstall.localPort}`;
      return {
        ok: res.provision ? res.provision.ok : true,
        instanceDir: res.instanceDir,
        version: res.version,
        publicUrl,
        detail: res.provision ? `Provisioning ${res.provision.ok ? 'succeeded' : 'failed'}.` : 'Installed.',
      };
    },
    async checkHealth() {
      // Health was executed as the final provisioning step during runInstall.
      return { healthy: lastHealthOk, degraded: false, detail: lastHealthOk ? 'All services healthy.' : 'Health check failed during provisioning.' };
    },
  };

  const operatorStore = mode === 'persistent' ? new FileOperatorStore(path.join(root, 'manager', 'operators.json')) : undefined;

  const handle = createBootstrapServer({
    actions,
    mode,
    host,
    port,
    allowNonLocal,
    persistAfterBootstrap,
    clientDir,
    ...(operatorStore ? { operatorStore } : {}),
  });

  const bound = await handle.listen();
  console.log(`SelfHelp Manager ${mode} UI listening on http://${bound.host}:${bound.port}`);
  if (!allowNonLocal) console.log('Bound to localhost only. Use an SSH tunnel for remote access.');
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
