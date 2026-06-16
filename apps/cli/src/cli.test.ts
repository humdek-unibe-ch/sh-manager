// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupSchedulePolicy, TrustedKeysFile } from '@shm/schemas';
import { RecordingComposeRunner, type ComposeResult } from '@shm/docker';
import type { Fetcher, FetchResponse } from '@shm/registry';
import {
  LockStore,
  ManifestStore,
  generateInstanceSecrets,
  instancePaths,
  serverInventoryPath,
  writeInstanceSecrets,
} from '@shm/instances';
import type { ActionDeps } from './actions.js';
import {
  doctor,
  instanceBackup,
  instanceBackupPrune,
  instanceBackupScheduleGet,
  instanceBackupScheduleSet,
  instanceClone,
  instanceGetEnv,
  instanceGetMailer,
  instanceHealth,
  instanceInstall,
  instanceList,
  instanceLogs,
  instanceEnable,
  instanceRemove,
  instanceRepair,
  instanceRestore,
  instanceSetAddress,
  instanceSetEnv,
  instanceSetMailer,
  instanceSetName,
  instanceSupportBundle,
  serverInit,
  serverStartProxy,
  serverProxyLogs,
  ensureProxyRunning,
  serverPurge,
  serverRunScheduledBackups,
} from './actions.js';
import { formatHealth, formatPreflight, formatSteps, formatTable } from './output.js';

const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'schemas', 'examples');
const readExample = (n: string) => readFile(path.join(examplesDir, n), 'utf8');

/** Parse a `KEY=value` secrets.env into a map (values may contain `=`). */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

class FixtureFetcher implements Fetcher {
  constructor(private readonly map: Record<string, string>) {}
  async fetch(url: string): Promise<FetchResponse> {
    for (const [suffix, body] of Object.entries(this.map)) if (url.endsWith(suffix)) return { ok: true, status: 200, text: body };
    return { ok: false, status: 404, text: '' };
  }
}

let root: string;
let trustedKeys: TrustedKeysFile;
let runner: RecordingComposeRunner;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-cli-'));
  trustedKeys = JSON.parse(await readExample('trusted-keys.json')) as TrustedKeysFile;
  runner = new RecordingComposeRunner();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeDeps(): Promise<ActionDeps> {
  const fetcher = new FixtureFetcher({
    'registry.json': await readExample('registry-index.json'),
    'selfhelp-core-0.1.0.json': await readExample('core-release.json'),
    'selfhelp-frontend-0.1.0.json': await readExample('frontend-release.json'),
  });
  const digest = `sha256:${'a'.repeat(64)}`;
  return {
    root,
    managerVersion: '0.1.0',
    trustedKeys,
    runner,
    fetcher,
    resolveServiceDigests: async (images) => ({
      mysql: { image: images.mysql, digest },
      redis: { image: images.redis, digest },
      mercure: { image: images.mercure, digest },
    }),
    probeHealth: async () => [
      { service: 'backend', ok: true, detail: 'HTTP 200' },
      { service: 'frontend', ok: true, detail: 'HTTP 200' },
    ],
    resourceFacts: async (ports) => ({
      requiredPortsFree: ports.map((p) => ({ port: p, free: true })),
      diskBytesFree: 100 * 1024 * 1024 * 1024,
      memoryBytesTotal: 16 * 1024 * 1024 * 1024,
      cpuCount: 8,
      dockerAvailable: true,
      dockerComposeAvailable: true,
    }),
    now: () => '2026-06-05T10:00:00.000Z',
  };
}

describe('CLI actions (offline)', () => {
  it('server init writes proxy compose + inventory', async () => {
    const d = await makeDeps();
    const res = await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    const inv = JSON.parse(await readFile(res.inventoryPath, 'utf8')) as { serverId: string };
    expect(inv.serverId).toBe('s1');
  });

  it('server init (production) creates the shared proxy network and starts Traefik', async () => {
    const d = await makeDeps();
    const networks: string[] = [];
    d.ensureNetwork = async (name) => {
      networks.push(name);
    };
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    expect(networks).toEqual(['selfhelp_proxy']);
    expect(runner.calls).toEqual([{ cwd: path.join(root, 'proxy'), args: ['up', '-d'] }]);
  });

  it('server init (local) creates the network but does not start the proxy container', async () => {
    const d = await makeDeps();
    const networks: string[] = [];
    d.ensureNetwork = async (name) => {
      networks.push(name);
    };
    await serverInit(d, { serverId: 'dev', mode: 'local' });
    expect(networks).toEqual(['selfhelp_proxy']);
    expect(runner.calls).toEqual([]);
  });

  it('instance install --up ensures the proxy network exists before compose up', async () => {
    const d = await makeDeps();
    const networks: string[] = [];
    d.ensureNetwork = async (name) => {
      networks.push(name);
    };
    await serverInit(d, { serverId: 'dev', mode: 'local' });
    await instanceInstall(d, {
      instanceId: 'qa1',
      displayName: 'QA 1',
      mode: 'local',
      localPort: 8080,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      bringUp: true,
    });
    // Once from server init, once defensively before bringing the stack up.
    expect(networks).toEqual(['selfhelp_proxy', 'selfhelp_proxy']);
    const upCall = runner.calls.find((c) => c.cwd.includes('qa1'));
    expect(upCall?.args).toEqual(['up', '-d']);
  });

  it('instance install (production) (re)starts the shared proxy so a half-bootstrapped server self-heals', async () => {
    // Regression: the proxy was only started by the FIRST server init. If that
    // bring-up failed (the pre-1.5.1 proxy-network label bug, or an Apache/nginx
    // holding 80/443 at init time) the inventory was still written, so every
    // later reinstall skipped init and the proxy stayed down — the instance
    // installed fine but was unreachable with health "unhealthy".
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    const proxyDirPath = path.join(root, 'proxy');
    const proxyUps = () => runner.calls.filter((c) => c.cwd === proxyDirPath && c.args.join(' ') === 'up -d').length;
    const before = proxyUps();
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      bringUp: true,
    });
    expect(proxyUps()).toBe(before + 1);
  });

  it('instance install (local) never starts the shared proxy (must not grab 80/443 on a dev host)', async () => {
    const d = await makeDeps();
    await serverInit(d, { serverId: 'dev', mode: 'local' });
    const proxyDirPath = path.join(root, 'proxy');
    await instanceInstall(d, {
      instanceId: 'demo1',
      displayName: 'Demo 1',
      mode: 'local',
      localPort: 8080,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      bringUp: true,
    });
    expect(runner.calls.filter((c) => c.cwd === proxyDirPath).length).toBe(0);
  });

  it('server start repairs a production server by (re)starting the proxy, and is a no-op for a local-only server', async () => {
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      bringUp: false,
    });
    const proxyDirPath = path.join(root, 'proxy');
    const proxyUps = () => runner.calls.filter((c) => c.cwd === proxyDirPath && c.args.join(' ') === 'up -d').length;
    const before = proxyUps();
    const res = await serverStartProxy(d);
    expect(res.started).toBe(true);
    expect(proxyUps()).toBe(before + 1);
  });

  it('server logs reads the shared proxy logs from the proxy dir, clamps the tail, and redacts secrets', async () => {
    // Surfaced so an operator can diagnose the edge (the Docker-provider "client
    // version 1.24 is too old" 404, ACME failures) from the manager. It must read
    // the PROXY compose (not an instance), clamp an out-of-range tail, and never
    // leak a secret that happens to appear in a log line.
    const d = await makeDeps();
    const logRunner = new RecordingComposeRunner(() => ({
      stdout:
        'traefik  | level=info msg="Configuration loaded"\n' +
        'traefik  | DATABASE_URL=mysql://app:supersecret@mysql:3306/db\n',
      stderr: '',
    }));
    d.runner = logRunner;

    const res = await serverProxyLogs(d, { tail: 99999 });

    expect(res.tail).toBe(2000);
    expect(logRunner.calls[0]?.cwd).toBe(path.join(root, 'proxy'));
    expect(logRunner.calls[0]?.args).toEqual(['logs', '--no-color', '--tail=2000']);
    expect(res.text).toContain('Configuration loaded');
    expect(res.text).not.toContain('supersecret');
    expect(res.readAt).toBe('2026-06-05T10:00:00.000Z');
  });

  it('server logs never throws when the proxy has not been started yet (returns a readable message)', async () => {
    const d = await makeDeps();
    d.runner = new RecordingComposeRunner(() => {
      throw new Error('no such service: traefik');
    });
    const res = await serverProxyLogs(d, {});
    expect(res.text).toMatch(/Could not read proxy logs/i);
  });

  it('ensureProxyRunning self-heals a stale (pre-1.5.1, non-external) proxy compose before starting it', async () => {
    // The proxy compose written by a manager < 1.5.1 declared the shared network
    // as non-external, so `docker compose up` aborts with a label mismatch — the
    // exact state a server is stuck in after that failed first bootstrap. The
    // start/ensure path must regenerate it (external network) so it can come up.
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    const proxyComposePath = path.join(root, 'proxy', 'compose.yaml');
    const current = await readFile(proxyComposePath, 'utf8');
    expect(current).toContain('external: true');
    await writeFile(proxyComposePath, current.replace('external: true', 'external: false'));

    await ensureProxyRunning(d, 'production');

    const healed = await readFile(proxyComposePath, 'utf8');
    expect(healed).toContain('external: true');
    expect(healed).not.toContain('external: false');
    // The Let's Encrypt email survives the regeneration (recovered from disk).
    expect(healed).toContain('acme.email=ops@example.ch');
  });

  it('refuses to re-bootstrap an already-managed server unless import is acknowledged', async () => {
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await expect(
      serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' }),
    ).rejects.toThrow(/already bootstrapped/);
    // Explicit import/repair acknowledgement reconciles instead of refusing.
    await expect(
      serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch', allowImport: true }),
    ).resolves.toBeTruthy();
  });

  it('resumes a half-finished bootstrap (inventory, no instances) after a manager restart', async () => {
    // First wizard attempt got as far as server init, then failed before any
    // instance dir existed (e.g. registry error). The manager was restarted
    // (in-memory retry acknowledgement lost), the operator reinstalls.
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'local' });
    await expect(
      serverInit(d, { serverId: 's1', mode: 'local', resumeInstanceId: 'demo1' }),
    ).resolves.toBeTruthy();
  });

  it('resumes when the only instance on disk is the one being reinstalled', async () => {
    // First attempt created the instance dir and then failed mid-provisioning
    // (e.g. wait_db). A reinstall of the SAME instance id must continue
    // automatically — nothing has to be deleted first.
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'resume.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
    await expect(
      serverInit(d, {
        serverId: 's1',
        mode: 'production',
        letsencryptEmail: 'ops@example.ch',
        resumeInstanceId: 'website1',
      }),
    ).resolves.toBeTruthy();
  });

  it('still refuses to resume over a server that hosts OTHER instances', async () => {
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'other.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
    await expect(
      serverInit(d, {
        serverId: 's1',
        mode: 'production',
        letsencryptEmail: 'ops@example.ch',
        resumeInstanceId: 'website2',
      }),
    ).rejects.toThrow(/already bootstrapped/);
  });

  it('emits engine-side bind sources end to end when the engine sees the root elsewhere', async () => {
    // The Docker Desktop / Windows case: the manager container sees the state
    // root at `root`, the engine sees it under /run/desktop/mnt/host/… . The
    // generated proxy + instance compose files must bind from the ENGINE view.
    const engineRoot = '/run/desktop/mnt/host/d/selfhelp';
    const d: ActionDeps = { ...(await makeDeps()), engineRoot };
    await serverInit(d, { serverId: 'win', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    const proxyCompose = await readFile(path.join(root, 'proxy', 'compose.yaml'), 'utf8');
    expect(proxyCompose).toContain(`${engineRoot}/proxy/letsencrypt:/letsencrypt`);

    await instanceInstall(d, {
      instanceId: 'demo1',
      displayName: 'Demo 1',
      mode: 'local',
      localPort: 8080,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
    const compose = await readFile(instancePaths('demo1', root).composePath, 'utf8');
    expect(compose).toContain(`${engineRoot}/instances/demo1/secrets/jwt:/app/config/jwt:ro`);
    expect(compose).not.toContain('./secrets/jwt');
  });

  it('installs an instance from the signed fixture registry', async () => {
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    const res = await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
    expect(res.version).toBe('0.1.0');
    const manifest = await new ManifestStore('website1', root).read();
    const lock = await new LockStore('website1', root).read();
    expect(manifest.images.frontend).toContain('selfhelp-frontend:0.1.0');
    expect(lock.core.version).toBe('0.1.0');

    const list = await instanceList(d);
    expect(list.map((i) => i.instanceId)).toContain('website1');
  });

  it('rejects a second instance that reuses an existing domain', async () => {
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'dup.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
    await expect(
      instanceInstall(d, {
        instanceId: 'website2',
        displayName: 'Website 2',
        mode: 'production',
        domain: 'dup.example.ch',
        registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
        version: 'latest',
      }),
    ).rejects.toThrow(/already used by another instance/);
  });

  it('allows re-installing the same instance id over its own domain (retry after a failed attempt)', async () => {
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    const opts = {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production' as const,
      domain: 'retry.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    };
    await instanceInstall(d, opts);
    // The first attempt registered website1 + its domain in the inventory; a
    // re-run of the SAME instance must not trip the duplicate-domain guard.
    await expect(instanceInstall(d, opts)).resolves.toBeTruthy();
  });

  it('import/repair re-bootstrap keeps already-registered instances in the inventory', async () => {
    const d = await makeDeps();
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'keep.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });

    const res = await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch', allowImport: true });
    const inv = JSON.parse(await readFile(res.inventoryPath, 'utf8')) as { instances: { instanceId: string }[] };
    expect(inv.instances.map((i) => i.instanceId)).toContain('website1');
  });

  it('warns when DNS does not point at this server and blocks under strictDns', async () => {
    const d = await makeDeps();
    d.resolveDns = async () => ({ a: ['203.0.113.9'], aaaa: [] });
    d.serverPublicIp = async () => '198.51.100.5';
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });

    const res = await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'dnswarn.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
    expect(res.domainWarnings.join(' ')).toMatch(/DNS check/);

    await expect(
      instanceInstall(d, {
        instanceId: 'website2',
        displayName: 'Website 2',
        mode: 'production',
        domain: 'dnsblock.example.ch',
        strictDns: true,
        registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
        version: 'latest',
      }),
    ).rejects.toThrow(/DNS check/);
  });

  it('doctor reports ok with healthy resources', async () => {
    const d = await makeDeps();
    const pf = await doctor(d, [80, 443]);
    expect(pf.status).toBe('ok');
  });

  it('provision runs migrations + admin + plugins + cache + health via backend console', async () => {
    const d = await makeDeps();
    d.sleep = async () => {};
    d.dbWaitDelayMs = 0;
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });

    const res = await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      provision: true,
      adminEmail: 'qa.admin@selfhelp.test',
      pluginManifests: ['/srv/plugins/surveyjs/plugin.json'],
    });

    expect(res.broughtUp).toBe(true);
    expect(res.provision?.ok).toBe(true);
    // No password supplied -> a strong one is generated and returned exactly once.
    expect(res.adminPassword).toBeTruthy();
    expect(res.adminPassword!.length).toBeGreaterThanOrEqual(20);

    const joined = runner.calls.map((c) => c.args.join(' '));
    expect(joined).toContain('up -d');
    expect(joined.some((a) => a.includes('dbal:run-sql SELECT 1'))).toBe(true);
    expect(joined.some((a) => a.includes('doctrine:migrations:migrate --no-interaction --allow-no-migration'))).toBe(true);
    expect(joined.some((a) => a.includes('app:create-admin-user qa.admin@selfhelp.test'))).toBe(true);
    expect(joined.some((a) => a.includes('selfhelp:plugin:install /srv/plugins/surveyjs/plugin.json'))).toBe(true);
    expect(joined.some((a) => a.includes('cache:clear-api-routes'))).toBe(true);
    expect(joined.some((a) => a.includes('cache:clear'))).toBe(true);
    // Regression: the long-lived FrankenPHP backend compiled its router before
    // migrations seeded the DB-backed routes, so provisioning must restart it
    // (otherwise every migrated route, incl. /cms-api/v1/health, 404s).
    expect(joined).toContain('restart backend');

    // The generated admin password must never land in the manifest or lock.
    const manifestText = await readFile(instancePaths('website1', root).manifestPath, 'utf8');
    const lockText = await readFile(instancePaths('website1', root).lockPath, 'utf8');
    expect(manifestText).not.toContain(res.adminPassword!);
    expect(lockText).not.toContain(res.adminPassword!);
  });

  it('install reports every stage through onStep so the GUI can show live progress', async () => {
    const d = await makeDeps();
    d.sleep = async () => {};
    d.dbWaitDelayMs = 0;
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });

    const stages: string[] = [];
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      provision: true,
      adminEmail: 'qa.admin@selfhelp.test',
      onStep: (s) => {
        stages.push(s);
      },
    });

    // The journaled phases the create wizard's checklist is driven by:
    // pre-up stages, then every provisioning step in execution order.
    expect(stages).toEqual(['registry', 'compose', 'start', 'wait_db', 'migrations', 'admin', 'cache_warm', 'health']);
  });

  it('provision fails fast on a failed migration and never creates an admin', async () => {
    const d = await makeDeps();
    d.sleep = async () => {};
    d.dbWaitDelayMs = 0;
    d.runner = new RecordingComposeRunner((args: string[]): ComposeResult => {
      if (args.join(' ').includes('doctrine:migrations:migrate')) throw new Error('migration boom');
      return { stdout: '', stderr: '' };
    });
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });

    const res = await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      provision: true,
      adminEmail: 'qa.admin@selfhelp.test',
    });

    expect(res.provision?.ok).toBe(false);
    expect(res.provision?.steps.find((s) => s.name === 'migrations')?.status).toBe('failed');
    const joined = (d.runner as RecordingComposeRunner).calls.map((c) => c.args.join(' '));
    expect(joined.some((a) => a.includes('app:create-admin-user'))).toBe(false);
  });

  it('wait_db fails fast with remediation when MySQL rejects the credentials (stale volume)', async () => {
    // Regression: a mysql_data volume left over from an earlier install (whose
    // secrets were since regenerated) makes the backend's DB connection fail
    // with SQLSTATE 1045 "Access denied". That is deterministic — burning the
    // full 60x2s retry budget only delayed an opaque PDO stack trace.
    const d = await makeDeps();
    d.sleep = async () => {};
    d.dbWaitDelayMs = 0;
    d.dbWaitAttempts = 60;
    const denyRunner = new RecordingComposeRunner((args: string[]): ComposeResult => {
      if (args.join(' ').includes('dbal:run-sql')) {
        throw new Error(
          'Command failed: docker compose exec -T backend php bin/console dbal:run-sql SELECT 1\n' +
            "An exception occurred in the driver: SQLSTATE[HY000] [1045] Access denied for user 'selfhelp'@'172.19.0.8' (using password: YES)",
        );
      }
      return { stdout: '', stderr: '' };
    });
    d.runner = denyRunner;
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });

    const res = await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      provision: true,
      adminEmail: 'qa.admin@selfhelp.test',
    });

    expect(res.provision?.ok).toBe(false);
    const waitDb = res.provision?.steps.find((s) => s.name === 'wait_db');
    expect(waitDb?.status).toBe('failed');
    // The operator gets the cause + the exact remediation command, not a raw trace.
    expect(waitDb?.detail).toContain('selfhelp_website1_mysql_data');
    expect(waitDb?.detail).toContain('full_delete --delete-volumes');
    expect(waitDb?.detail).toContain('Access denied');
    // Fail-fast: a handful of conclusive rejections, never the full 60-attempt budget.
    const dbalCalls = denyRunner.calls.filter((c) => c.args.join(' ').includes('dbal:run-sql'));
    expect(dbalCalls.length).toBe(3);
  });

  it('persists the generated admin password to secrets/admin_password and reuses it on a resumed install', async () => {
    const d = await makeDeps();
    d.sleep = async () => {};
    d.dbWaitDelayMs = 0;
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    const opts = {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production' as const,
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      provision: true,
      adminEmail: 'qa.admin@selfhelp.test',
    };

    const first = await instanceInstall(d, opts);
    expect(first.adminPassword).toBeTruthy();
    const file = path.join(instancePaths('website1', root).secretsDir, 'admin_password');
    expect(first.adminPasswordFile).toBe(file);
    expect((await readFile(file, 'utf8')).trim()).toBe(first.adminPassword);

    // Retry/resume of the same instance: the admin row in the DB already
    // carries the FIRST password, so the re-run must reuse it, not regenerate.
    const second = await instanceInstall(d, opts);
    expect(second.adminPassword).toBe(first.adminPassword);
  });

  it('uses an explicitly supplied admin password as-is and never writes it to disk', async () => {
    const d = await makeDeps();
    d.sleep = async () => {};
    d.dbWaitDelayMs = 0;
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });

    const res = await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
      provision: true,
      adminEmail: 'qa.admin@selfhelp.test',
      adminPassword: 'operator-chosen-pw',
    });

    expect(res.provision?.ok).toBe(true);
    // Supplied by the operator -> not returned, not persisted.
    expect(res.adminPassword).toBeUndefined();
    expect(res.adminPasswordFile).toBeUndefined();
    const file = path.join(instancePaths('website1', root).secretsDir, 'admin_password');
    await expect(readFile(file, 'utf8')).rejects.toThrow();
    const joined = runner.calls.map((c) => c.args.join(' '));
    expect(joined.some((a) => a.includes('--password=operator-chosen-pw'))).toBe(true);
  });
});

describe('instance lifecycle (offline)', () => {
  /** A deps variant whose runner answers mysqldump and that can archive/remove/restore volumes. */
  async function lifecycleDeps(): Promise<{
    d: ActionDeps;
    runner: RecordingComposeRunner;
    removedVolumes: string[];
    extracted: { tgz: string; volumeName: string }[];
    copied: { from: string; to: string }[];
    imported: string[];
  }> {
    const base = await makeDeps();
    const removedVolumes: string[] = [];
    const extracted: { tgz: string; volumeName: string }[] = [];
    const copied: { from: string; to: string }[] = [];
    const imported: string[] = [];
    const respond = (args: string[]): ComposeResult =>
      args.join(' ').includes('mysqldump') ? { stdout: '-- dump\n', stderr: '' } : { stdout: '', stderr: '' };
    const lifecycleRunner = new RecordingComposeRunner(respond);
    const d: ActionDeps = {
      ...base,
      runner: lifecycleRunner,
      archiveVolume: async (_volumeName, outFile) => {
        await writeFile(outFile, 'archive-bytes');
      },
      removeVolumes: async (names) => {
        removedVolumes.push(...names);
      },
      extractVolume: async (tgz, volumeName) => {
        extracted.push({ tgz: path.basename(tgz), volumeName });
      },
      copyVolume: async (from, to) => {
        copied.push({ from, to });
      },
      importDatabase: async (_instanceDir, sqlFile) => {
        imported.push(path.basename(sqlFile));
      },
    };
    return { d, runner: lifecycleRunner, removedVolumes, extracted, copied, imported };
  }

  async function installWebsite1(d: ActionDeps): Promise<void> {
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
  }

  it('backup writes a checksummed manifest covering every required area', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);

    const res = await instanceBackup(d, 'website1');
    expect(res.backupId).toMatch(/^backup-\d{8}-website1-\d{3}$/);
    expect(res.manifest.includedAreas).toEqual(
      expect.arrayContaining(['database', 'uploads', 'plugin_artifacts', 'manifest', 'lock']),
    );
    expect(res.manifest.files.length).toBeGreaterThan(0);
    for (const f of res.manifest.files) expect(f.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The dump was produced in the db container and persisted.
    const dump = await readFile(path.join(res.backupDir, 'database.sql'), 'utf8');
    expect(dump).toContain('-- dump');
  });

  it('two same-day backups get distinct ids and never overwrite each other (regression)', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);

    // deps.now is frozen, so both backups land on the same calendar day.
    const first = await instanceBackup(d, 'website1');
    const second = await instanceBackup(d, 'website1');

    expect(first.backupId).not.toBe(second.backupId);
    expect(first.backupId.endsWith('-001')).toBe(true);
    expect(second.backupId.endsWith('-002')).toBe(true);
    // The first backup is still intact (its manifest still describes itself).
    const firstManifest = JSON.parse(
      await readFile(path.join(first.backupDir, 'backup-manifest.json'), 'utf8'),
    ) as { backupId: string };
    expect(firstManifest.backupId).toBe(first.backupId);
  });

  it('tags backups with their origin (manual default, pre_update/pre_restore/scheduled explicit)', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);

    const manual = await instanceBackup(d, 'website1');
    expect(manual.manifest.origin).toBe('manual');

    const preUpdate = await instanceBackup(d, 'website1', { origin: 'pre_update' });
    expect(preUpdate.manifest.origin).toBe('pre_update');
    const onDisk = JSON.parse(
      await readFile(path.join(preUpdate.backupDir, 'backup-manifest.json'), 'utf8'),
    ) as { origin: string };
    expect(onDisk.origin).toBe('pre_update');
  });

  describe('scheduled backups + GFS retention', () => {
    const policy = (overrides: Partial<BackupSchedulePolicy> = {}): BackupSchedulePolicy => ({
      enabled: true,
      time: '02:00',
      retention: { daily: 7, weekly: 5, monthly: 12, maxAgeDays: 365 },
      ...overrides,
    });

    /** Drops a synthetic backup dir with a self-consistent manifest on disk. */
    async function seedBackupDir(
      instanceId: string,
      createdAtLocalIso: string,
      origin: string,
      seqNo: number,
    ): Promise<string> {
      const at = new Date(createdAtLocalIso);
      const p = (n: number) => String(n).padStart(2, '0');
      const yyyymmdd = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
      const backupId = `backup-${yyyymmdd}-${instanceId}-${String(seqNo).padStart(3, '0')}`;
      const dir = path.join(instancePaths(instanceId, root).backupsDir, backupId);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'backup-manifest.json'),
        JSON.stringify({
          backupManifestVersion: 1,
          backupId,
          instanceId,
          createdAt: createdAtLocalIso,
          mode: 'online',
          origin,
          selfhelpVersion: '0.1.0',
          migrationVersion: 'V1',
          plugins: [],
          includedAreas: ['database'],
          files: [{ path: 'database.sql', sha256: `sha256:${'a'.repeat(64)}`, bytes: 1000 }],
        }),
      );
      return backupId;
    }

    it('schedule set persists the policy on the manifest and get reports the next run', async () => {
      const { d } = await lifecycleDeps();
      await installWebsite1(d);

      const status = await instanceBackupScheduleSet(d, 'website1', policy(), new Date(2026, 5, 5, 9, 0));
      expect(status.policy?.enabled).toBe(true);
      expect(status.nextRunAt).not.toBeNull();

      // Survives a re-read through the validated store (schema accepts it).
      const manifest = await new ManifestStore('website1', root).read();
      expect(manifest.backupSchedule?.time).toBe('02:00');
      expect(manifest.backupSchedule?.retention.monthly).toBe(12);
    });

    it('schedule set refuses an invalid policy (no partial writes)', async () => {
      const { d } = await lifecycleDeps();
      await installWebsite1(d);
      await expect(instanceBackupScheduleSet(d, 'website1', policy({ time: '25:00' }))).rejects.toThrow(/Invalid backup schedule/);
      const manifest = await new ManifestStore('website1', root).read();
      expect(manifest.backupSchedule).toBeUndefined();
    });

    it('run-scheduled-backups takes a due backup once, tags it scheduled, and never double-runs (guard)', async () => {
      const { d } = await lifecycleDeps();
      await installWebsite1(d);
      await instanceBackupScheduleSet(d, 'website1', policy());

      const now = new Date(2026, 5, 5, 12, 0); // matches deps.now's calendar day
      const first = await serverRunScheduledBackups(d, { now });
      expect(first.entries).toHaveLength(1);
      expect(first.entries[0]!.action).toBe('backup_taken');
      const backupId = first.entries[0]!.backupId!;
      const backupDir = path.join(instancePaths('website1', root).backupsDir, backupId);
      const manifest = JSON.parse(await readFile(path.join(backupDir, 'backup-manifest.json'), 'utf8')) as { origin: string };
      expect(manifest.origin).toBe('scheduled');

      // Same tick again (web loop + cron overlap): the occurrence is covered.
      const second = await serverRunScheduledBackups(d, { now });
      expect(second.entries[0]!.action).toBe('skipped_not_due');

      // Next day: due again.
      const third = await serverRunScheduledBackups(d, { now: new Date(2026, 5, 6, 12, 0) });
      expect(third.entries[0]!.action).toBe('backup_taken');
      expect(third.entries[0]!.backupId).not.toBe(backupId);
    });

    it('skips (and records) the run when free disk is below the safety margin', async () => {
      const { d } = await lifecycleDeps();
      await installWebsite1(d);
      await instanceBackupScheduleSet(d, 'website1', policy());
      d.resourceFacts = async () => ({
        requiredPortsFree: [],
        diskBytesFree: 10 * 1024 * 1024, // 10 MiB << 512 MiB floor
        memoryBytesTotal: 16 * 1024 * 1024 * 1024,
        cpuCount: 8,
        dockerAvailable: true,
        dockerComposeAvailable: true,
      });

      const now = new Date(2026, 5, 5, 12, 0);
      const res = await serverRunScheduledBackups(d, { now });
      expect(res.entries[0]!.action).toBe('skipped_low_disk');
      // No backup directory was created.
      const names = await readdir(instancePaths('website1', root).backupsDir).catch(() => []);
      expect(names).toHaveLength(0);
      // The occurrence is marked covered (no retry storm) and surfaced in status.
      const again = await serverRunScheduledBackups(d, { now: new Date(2026, 5, 5, 12, 5) });
      expect(again.entries[0]!.action).toBe('skipped_not_due');
      const status = await instanceBackupScheduleGet(d, 'website1', now);
      expect(status.lastResult).toBe('skipped_low_disk');
    });

    it('instances without an enabled schedule are left alone', async () => {
      const { d } = await lifecycleDeps();
      await installWebsite1(d);
      const res = await serverRunScheduledBackups(d, { now: new Date(2026, 5, 5, 12, 0) });
      expect(res.entries).toHaveLength(0);
      await instanceBackupScheduleSet(d, 'website1', policy({ enabled: false }));
      const res2 = await serverRunScheduledBackups(d, { now: new Date(2026, 5, 5, 12, 0) });
      expect(res2.entries).toHaveLength(0);
    });

    it('prune deletes exactly the planned scheduled backups and never touches manual/safety/foreign dirs', async () => {
      const { d } = await lifecycleDeps();
      await installWebsite1(d);
      await instanceBackupScheduleSet(d, 'website1', policy({ retention: { daily: 2, weekly: 0, monthly: 0, maxAgeDays: 365 } }));

      const now = new Date(2026, 5, 12, 12, 0);
      const keepA = await seedBackupDir('website1', '2026-06-12T02:00:00', 'scheduled', 1);
      const keepB = await seedBackupDir('website1', '2026-06-11T02:00:00', 'scheduled', 1);
      const dropC = await seedBackupDir('website1', '2026-06-10T02:00:00', 'scheduled', 1);
      const manualOld = await seedBackupDir('website1', '2026-01-05T08:00:00', 'manual', 1);
      const preUpdate = await seedBackupDir('website1', '2026-06-01T08:00:00', 'pre_update', 2);
      // Foreign / corrupt content that must never be deleted:
      const backupsDir = instancePaths('website1', root).backupsDir;
      await mkdir(path.join(backupsDir, 'random-folder'), { recursive: true });
      const renamed = path.join(backupsDir, 'backup-20260301-website1-099');
      await mkdir(renamed, { recursive: true });
      await writeFile(
        path.join(renamed, 'backup-manifest.json'),
        JSON.stringify({ backupId: 'backup-20260301-website1-001', instanceId: 'website1', createdAt: '2026-03-01T02:00:00', origin: 'scheduled', files: [] }),
      );

      // Dry run deletes nothing.
      const dry = await instanceBackupPrune(d, 'website1', { dryRun: true, now });
      expect(dry.deleted).toHaveLength(0);
      expect((await readdir(backupsDir)).length).toBe(7);
      expect(dry.plan.prune.map((p) => p.backupId)).toEqual([dropC]);

      // Real prune deletes exactly the planned set.
      const res = await instanceBackupPrune(d, 'website1', { now });
      expect(res.deleted).toEqual([dropC]);
      const remaining = await readdir(backupsDir);
      expect(remaining).toContain(keepA);
      expect(remaining).toContain(keepB);
      expect(remaining).toContain(manualOld);
      expect(remaining).toContain(preUpdate);
      expect(remaining).toContain('random-folder');
      expect(remaining).toContain('backup-20260301-website1-099');
      expect(remaining).not.toContain(dropC);
      // The mismatched dir was reported as skipped, not deleted.
      expect(res.skipped.some((s) => s.name === 'backup-20260301-website1-099')).toBe(true);
    });

    it('scheduled runs prune old nightly backups automatically (end to end, offline)', async () => {
      const { d } = await lifecycleDeps();
      await installWebsite1(d);
      await instanceBackupScheduleSet(d, 'website1', policy({ retention: { daily: 3, weekly: 0, monthly: 0, maxAgeDays: 365 } }));

      // Seed a week of old nightlies (June 1..5).
      for (let day = 1; day <= 5; day++) {
        await seedBackupDir('website1', `2026-06-0${day}T02:00:00`, 'scheduled', 1);
      }
      // deps.now() pins createdAt to 2026-06-05, so use a matching "now".
      const res = await serverRunScheduledBackups(d, { now: new Date(2026, 5, 5, 12, 0) });
      expect(res.entries[0]!.action).toBe('backup_taken');
      // Retention daily=3 keeps the 3 newest distinct days (Jun 5 incl. the new
      // backup, Jun 4, Jun 3) and prunes Jun 1 + Jun 2.
      expect(res.entries[0]!.prunedCount).toBe(2);
      const remaining = await readdir(instancePaths('website1', root).backupsDir);
      expect(remaining.some((n) => n.startsWith('backup-20260601'))).toBe(false);
      expect(remaining.some((n) => n.startsWith('backup-20260602'))).toBe(false);
      expect(remaining.some((n) => n.startsWith('backup-20260603'))).toBe(true);
    });
  });

  it('restore validates the just-created backup and returns a same-instance plan', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);
    const backup = await instanceBackup(d, 'website1');

    const res = await instanceRestore(d, 'website1', backup.backupId);
    expect(res.validation.ok).toBe(true);
    expect(res.plan).not.toBeNull();
    expect(res.plan!.mode).toBe('same_instance');
  });

  it('restore refuses a backup id that does not exist', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);
    const res = await instanceRestore(d, 'website1', 'backup-does-not-exist');
    expect(res.validation.ok).toBe(false);
    expect(res.plan).toBeNull();
  });

  it('support-bundle writes redacted files', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);
    const res = await instanceSupportBundle(d, 'website1');
    expect(res.files).toContain('support-bundle.json');
    expect(res.files).toContain('manifest.json');
    const meta = JSON.parse(await readFile(path.join(res.dir, 'support-bundle.json'), 'utf8')) as { redactionApplied: boolean };
    expect(meta.redactionApplied).toBe(true);
  });

  it('remove --mode disable marks the inventory entry disabled', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);
    const res = await instanceRemove(d, 'website1', { mode: 'disable' });
    expect(res.executed).toBe(true);
    const list = await instanceList(d);
    expect(list.find((i) => i.instanceId === 'website1')?.status).toBe('disabled');
  });

  it('enable brings a disabled instance back: up -d + status active again', async () => {
    const { d, runner: lifecycleRunner } = await lifecycleDeps();
    await installWebsite1(d);
    await instanceRemove(d, 'website1', { mode: 'disable' });

    const website1Dir = instancePaths('website1', root).dir;
    const callsBefore = lifecycleRunner.calls.filter((c) => c.cwd === website1Dir).length;

    const res = await instanceEnable(d, 'website1');
    expect(res.executed).toBe(true);
    expect(res.newStatus).toBe('active');

    // It brought the stack back with `up -d` (never `-v`).
    const enableCalls = lifecycleRunner.calls.filter((c) => c.cwd === website1Dir).slice(callsBefore);
    expect(enableCalls.some((c) => c.args.join(' ') === 'up -d')).toBe(true);
    expect(enableCalls.some((c) => c.args.includes('-v') || c.args.includes('--volumes'))).toBe(false);

    // The inventory entry is active again.
    const list = await instanceList(d);
    expect(list.find((i) => i.instanceId === 'website1')?.status).toBe('active');
  });

  it('enable refuses an instance that is already active', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);
    const res = await instanceEnable(d, 'website1');
    expect(res.executed).toBe(false);
    expect(res.errors.join(' ')).toContain('already active');
  });

  it('remove --mode full_delete removes the entry + volumes after typed confirmation', async () => {
    const { d, removedVolumes } = await lifecycleDeps();
    await installWebsite1(d);

    const blocked = await instanceRemove(d, 'website1', { mode: 'full_delete', deleteVolumes: true });
    expect(blocked.executed).toBe(false);

    const ok = await instanceRemove(d, 'website1', {
      mode: 'full_delete',
      deleteVolumes: true,
      confirm: 'delete website1',
    });
    expect(ok.executed).toBe(true);
    expect(removedVolumes).toContain('selfhelp_website1_mysql_data');
    const list = await instanceList(d);
    expect(list.find((i) => i.instanceId === 'website1')).toBeUndefined();
  });

  it('server purge tears down every instance, the proxy, and the manager state — keeping backups and the audit log', async () => {
    const { d, removedVolumes } = await lifecycleDeps();
    await installWebsite1(d);
    await instanceBackup(d, 'website1');
    // Manager state a purge must reset (so the next start is a true first run).
    const managerDir = path.join(root, 'manager');
    await mkdir(path.join(managerDir, 'operations'), { recursive: true });
    await writeFile(path.join(managerDir, 'operators.json'), '{"version":1,"operators":[]}');
    await writeFile(path.join(managerDir, 'audit.jsonl'), '{"action":"instance_create"}\n');

    // Without the typed confirmation nothing happens.
    const blocked = await serverPurge(d, {});
    expect(blocked.ok).toBe(false);
    expect(blocked.instancesRemoved).toEqual([]);
    expect(await instanceList(d)).toHaveLength(1);

    const res = await serverPurge(d, { confirm: 'purge selfhelp' });
    expect(res.ok).toBe(true);
    expect(res.instancesRemoved).toEqual(['website1']);
    expect(removedVolumes).toContain('selfhelp_website1_mysql_data');
    // Inventory is gone: the server reports "not initialized" again.
    await expect(instanceList(d)).rejects.toThrow(/selfhelp\.server\.json/);
    // Backups and the audit log survive; operators + journal are reset.
    await expect(readFile(path.join(managerDir, 'audit.jsonl'), 'utf8')).resolves.toContain('instance_create');
    await expect(readFile(path.join(managerDir, 'operators.json'), 'utf8')).rejects.toThrow();
    expect(res.keptPaths.some((p) => p.includes('backups'))).toBe(true);
    expect(res.keptPaths).toContain(path.join(managerDir, 'audit.jsonl'));

    // Regression: the retained backup folders must NOT block the next
    // bootstrap as "partial or foreign install" — a purged server can be
    // re-initialized immediately.
    await expect(serverInit(d, { serverId: 's2', mode: 'production', letsencryptEmail: 'ops@example.ch' })).resolves.toBeTruthy();
    expect(await instanceList(d)).toHaveLength(0);
  });

  it('clone produces an isolated plan that pins the source versions', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);
    const res = await instanceClone(d, 'website1', 'website1-staging', { targetDomain: 'website1-staging.example.ch' });
    expect(res.plan.targetInstanceId).toBe('website1-staging');
    expect(res.plan.generateNewSecrets).toBe(true);
    expect(res.plan.steps.length).toBeGreaterThan(0);
    expect(formatSteps('Clone:', res.plan.steps)).toContain('Clone:');
  });

  it('clones a LOCAL instance by port alone — no domain required', async () => {
    // Regression: the clone path demanded a target domain even for local
    // (port-published) instances, so port clones could never run.
    const { d, copied } = await lifecycleDeps();
    await serverInit(d, { serverId: 's1', mode: 'local' });
    await instanceInstall(d, {
      instanceId: 'localtest',
      displayName: 'Local Test',
      mode: 'local',
      localPort: 9123,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });

    const res = await instanceClone(d, 'localtest', 'localtest-copy', { targetLocalPort: 9124, apply: true });
    expect(res.executed).toBe(true);
    expect(res.plan.targetDomain).toBe('localhost:9124');
    expect(copied.some((c) => c.to === 'selfhelp_localtest-copy_uploads')).toBe(true);

    // The clone publishes ITS port, not the source's.
    const compose = await readFile(instancePaths('localtest-copy', root).composePath, 'utf8');
    expect(compose).toContain('127.0.0.1:9124:3000');
    expect(compose).not.toContain('127.0.0.1:9123:3000');
  });

  it('carries the source admin password (the "admin sector") into the clone', async () => {
    // Regression: a clone copies the source DATABASE (admin user + hash come
    // along) but generates its own fresh secrets, so it had NO admin_password
    // file — leaving the operator unable to retrieve the (valid) cloned admin
    // login. The source's plaintext password must be copied so
    // `instance admin-password <clone>` keeps working.
    const { d } = await lifecycleDeps();
    await serverInit(d, { serverId: 's1', mode: 'local' });
    await instanceInstall(d, {
      instanceId: 'localtest',
      displayName: 'Local Test',
      mode: 'local',
      localPort: 9123,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });

    // The source has a persisted admin bootstrap password (as provisioning would write).
    const sourceFile = path.join(instancePaths('localtest', root).secretsDir, 'admin_password');
    await writeFile(sourceFile, 'source-admin-secret\n');

    const res = await instanceClone(d, 'localtest', 'localtest-copy', { targetLocalPort: 9124, apply: true });
    expect(res.executed).toBe(true);

    const cloneFile = path.join(instancePaths('localtest-copy', root).secretsDir, 'admin_password');
    expect((await readFile(cloneFile, 'utf8')).trim()).toBe('source-admin-secret');
    // Reported among the clone's written secrets.
    expect(res.secretsWritten?.some((p) => p.replace(/\\/g, '/').endsWith('secrets/admin_password'))).toBe(true);
  });

  it('does not write an admin_password to the clone when the source has none', async () => {
    // Operator-supplied passwords are never persisted; the clone must not invent
    // a file (there is nothing valid to retrieve).
    const { d } = await lifecycleDeps();
    await serverInit(d, { serverId: 's1', mode: 'local' });
    await instanceInstall(d, {
      instanceId: 'localtest',
      displayName: 'Local Test',
      mode: 'local',
      localPort: 9123,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });

    const res = await instanceClone(d, 'localtest', 'localtest-copy', { targetLocalPort: 9124, apply: true });
    expect(res.executed).toBe(true);

    const cloneFile = path.join(instancePaths('localtest-copy', root).secretsDir, 'admin_password');
    await expect(readFile(cloneFile, 'utf8')).rejects.toThrow();
  });

  it('reads recent container logs for a service and redacts secrets', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);

    // Swap in a runner that returns a log line carrying a secret-looking value.
    const logRunner = new RecordingComposeRunner((args) =>
      args[0] === 'logs'
        ? {
            stdout:
              'backend-1  | DATABASE_URL=mysql://app:supersecret@mysql:3306/db\nbackend-1  | [OK] ready\n',
            stderr: '',
          }
        : { stdout: '', stderr: '' },
    );
    d.runner = logRunner;

    const res = await instanceLogs(d, 'website1', { service: 'backend', tail: 50 });
    expect(res.service).toBe('backend');
    expect(res.tail).toBe(50);
    // Targeted the right service with the requested tail.
    expect(logRunner.calls[0]?.args).toEqual(['logs', '--no-color', '--tail=50', 'backend']);
    // Secrets never leave the server: the embedded DB password is redacted.
    expect(res.text).not.toContain('supersecret');
    expect(res.text).toContain('[OK] ready');
  });

  it('rejects an unknown log service and clamps the tail to the allowed range', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);

    await expect(instanceLogs(d, 'website1', { service: 'bogus' as never })).rejects.toThrow(/Unknown service/);

    const logRunner = new RecordingComposeRunner(() => ({ stdout: 'line\n', stderr: '' }));
    d.runner = logRunner;
    const res = await instanceLogs(d, 'website1', { service: 'frontend', tail: 99999 });
    expect(res.tail).toBe(2000);
    expect(logRunner.calls[0]?.args).toEqual(['logs', '--no-color', '--tail=2000', 'frontend']);
  });

  it('clone retries the database import when MySQL drops the first connection', async () => {
    // Regression: MySQL's first-boot temp-init server can answer the readiness
    // probe and then restart, so the first import dies mid-stream (ERROR 2002 /
    // broken stdin pipe). The dump is idempotent — the import must retry after
    // re-confirming readiness instead of failing (or crashing) the operation.
    const { d } = await lifecycleDeps();
    let importAttempts = 0;
    d.importDatabase = async () => {
      importAttempts++;
      if (importAttempts === 1) throw new Error('Database import exited with code 1.');
    };
    await serverInit(d, { serverId: 's1', mode: 'local' });
    await instanceInstall(d, {
      instanceId: 'localtest',
      displayName: 'Local Test',
      mode: 'local',
      localPort: 9123,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });

    const res = await instanceClone(d, 'localtest', 'localtest-copy', { targetLocalPort: 9124, apply: true });
    expect(res.executed).toBe(true);
    expect(importAttempts).toBe(2);
  });

  it('clone fails (not crashes) when the database import never succeeds', async () => {
    const { d } = await lifecycleDeps();
    d.importDatabase = async () => {
      throw new Error('Database import exited with code 1.');
    };
    await serverInit(d, { serverId: 's1', mode: 'local' });
    await instanceInstall(d, {
      instanceId: 'localtest',
      displayName: 'Local Test',
      mode: 'local',
      localPort: 9123,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });

    await expect(instanceClone(d, 'localtest', 'localtest-copy', { targetLocalPort: 9124, apply: true })).rejects.toThrow(
      /import failed after 3 attempts/i,
    );
  });

  it('refuses mode-mismatched clone addresses (local without port, production without domain)', async () => {
    const { d } = await lifecycleDeps();
    await serverInit(d, { serverId: 's1', mode: 'local' });
    await instanceInstall(d, {
      instanceId: 'localtest',
      displayName: 'Local Test',
      mode: 'local',
      localPort: 9123,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
    await expect(instanceClone(d, 'localtest', 'localtest-copy', { targetDomain: 'copy.example.ch' })).rejects.toThrow(
      /target local port/i,
    );
    await expect(instanceClone(d, 'website1', 'website1-staging', { targetLocalPort: 9124 })).rejects.toThrow(
      /target domain/i,
    );
  });

  it('set-address moves a production instance to a new domain and restarts it', async () => {
    const { d, runner: lifecycleRunner } = await lifecycleDeps();
    await installWebsite1(d);

    const res = await instanceSetAddress(d, 'website1', { domain: 'renamed.example.ch' });
    expect(res.changed).toBe(true);
    expect(res.previousDomain).toBe('website1.example.ch');
    expect(res.publicUrl).toBe('https://renamed.example.ch');
    expect(res.restarted).toBe(true);

    // Manifest, compose routing (frontend + mercure) and inventory all moved.
    const manifest = await new ManifestStore('website1', root).read();
    expect(manifest.domain).toBe('renamed.example.ch');
    const compose = await readFile(instancePaths('website1', root).composePath, 'utf8');
    expect(compose).toContain('Host(`renamed.example.ch`)');
    expect(compose).not.toContain('Host(`website1.example.ch`)');
    const inv = JSON.parse(await readFile(serverInventoryPath(root), 'utf8')) as {
      instances: { instanceId: string; domain: string }[];
    };
    expect(inv.instances.find((i) => i.instanceId === 'website1')?.domain).toBe('renamed.example.ch');
    // The containers were recreated to pick up the new routing; the calls
    // after the `up` are the best-effort plugin-state probe on the fresh
    // containers (recreates drop composer-installed plugins).
    const upIdx = lifecycleRunner.calls.findLastIndex((c) => c.args[0] === 'up');
    expect(lifecycleRunner.calls[upIdx]?.args).toEqual(['up', '-d']);
    for (const call of lifecycleRunner.calls.slice(upIdx + 1)) {
      expect(call.args.slice(0, 3)).toEqual(['exec', '-T', 'backend']);
    }

    // The version lock is untouched — an address change never bumps code.
    const lock = await new LockStore('website1', root).read();
    expect(lock.core.version).toBe('0.1.0');
  });

  it('set-address re-publishes a local instance on a new port and allows a same-port re-apply', async () => {
    const { d } = await lifecycleDeps();
    await serverInit(d, { serverId: 's1', mode: 'local' });
    await instanceInstall(d, {
      instanceId: 'localtest',
      displayName: 'Local Test',
      mode: 'local',
      localPort: 9123,
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });

    const res = await instanceSetAddress(d, 'localtest', { localPort: 9200 });
    expect(res.changed).toBe(true);
    expect(res.domain).toBe('localhost:9200');
    const compose = await readFile(instancePaths('localtest', root).composePath, 'utf8');
    expect(compose).toContain('127.0.0.1:9200:3000');

    // Re-applying the SAME address is a supported repair path (regenerates
    // config from the lock + restarts) and reports changed: false.
    const again = await instanceSetAddress(d, 'localtest', { localPort: 9200 });
    expect(again.changed).toBe(false);
    expect(again.restarted).toBe(true);
  });

  it('set-address refuses a domain already used by another instance', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);
    await instanceInstall(d, {
      instanceId: 'website2',
      displayName: 'Website 2',
      mode: 'production',
      domain: 'website2.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
    await expect(instanceSetAddress(d, 'website2', { domain: 'website1.example.ch' })).rejects.toThrow(
      /already used/i,
    );
  });

  it('rename changes ONLY the display name (id, domain, data, containers untouched)', async () => {
    const { d, runner: lifecycleRunner } = await lifecycleDeps();
    await installWebsite1(d);
    const callsBefore = lifecycleRunner.calls.length;

    const res = await instanceSetName(d, 'website1', { displayName: 'Clinic A (production)' });
    expect(res).toEqual({ changed: true, previousName: 'Website 1', displayName: 'Clinic A (production)' });

    // Manifest display name changed; the immutable id + domain did NOT.
    const manifest = await new ManifestStore('website1', root).read();
    expect(manifest.displayName).toBe('Clinic A (production)');
    expect(manifest.instanceId).toBe('website1');
    expect(manifest.domain).toBe('website1.example.ch');

    // The generated README reflects the new name (kept in sync).
    const readme = await readFile(instancePaths('website1', root).readmePath, 'utf8');
    expect(readme).toContain('Clinic A (production)');
    expect(readme).toContain('`website1`');

    // A rename is metadata only: it must NEVER touch Docker / restart anything.
    expect(lifecycleRunner.calls.length).toBe(callsBefore);
  });

  it('rename trims, re-rename to the same name reports changed:false, empty is rejected', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);

    const first = await instanceSetName(d, 'website1', { displayName: '  Spaced Name  ' });
    expect(first.displayName).toBe('Spaced Name');
    expect((await new ManifestStore('website1', root).read()).displayName).toBe('Spaced Name');

    const same = await instanceSetName(d, 'website1', { displayName: 'Spaced Name' });
    expect(same.changed).toBe(false);

    await expect(instanceSetName(d, 'website1', { displayName: '   ' })).rejects.toThrow(/display name is required/i);
  });

  it('clone --apply writes fresh secrets that share nothing with the source on disk', async () => {
    const base = await lifecycleDeps();
    const d: ActionDeps = { ...base.d, jwtModulusLength: 2048 };
    await installWebsite1(d);

    // Give the source a known secret set; the clone must never read or copy it.
    const srcPaths = instancePaths('website1', root);
    await writeInstanceSecrets(srcPaths.secretsDir, generateInstanceSecrets({ jwtModulusLength: 2048 }));
    const srcEnv = parseEnv(await readFile(path.join(srcPaths.secretsDir, 'secrets.env'), 'utf8'));

    const res = await instanceClone(d, 'website1', 'website1-staging', {
      targetDomain: 'website1-staging.example.ch',
      apply: true,
    });
    expect(res.secretsWritten?.some((p) => p.replace(/\\/g, '/').endsWith('secrets/secrets.env'))).toBe(true);

    const tgtPaths = instancePaths('website1-staging', root);
    const tgtEnv = parseEnv(await readFile(path.join(tgtPaths.secretsDir, 'secrets.env'), 'utf8'));
    for (const key of ['APP_SECRET', 'MYSQL_PASSWORD', 'REDIS_PASSWORD', 'MERCURE_JWT_SECRET', 'JWT_PASSPHRASE']) {
      expect(tgtEnv[key]).toBeTruthy();
      expect(tgtEnv[key]).not.toBe(srcEnv[key]);
    }
  });

  it('restore --apply preserves same-instance secrets but regenerates for restore_as_clone', async () => {
    const base = await lifecycleDeps();
    const d: ActionDeps = { ...base.d, jwtModulusLength: 2048 };
    await installWebsite1(d);

    const paths = instancePaths('website1', root);
    await writeInstanceSecrets(paths.secretsDir, generateInstanceSecrets({ jwtModulusLength: 2048 }));
    const before = parseEnv(await readFile(path.join(paths.secretsDir, 'secrets.env'), 'utf8'));
    const backup = await instanceBackup(d, 'website1');

    const same = await instanceRestore(d, 'website1', backup.backupId, { mode: 'same_instance', apply: true });
    expect(same.secretsRegenerated).toBe(false);
    const afterSame = parseEnv(await readFile(path.join(paths.secretsDir, 'secrets.env'), 'utf8'));
    expect(afterSame.APP_SECRET).toBe(before.APP_SECRET);

    const asClone = await instanceRestore(d, 'website1', backup.backupId, {
      mode: 'restore_as_clone',
      newDomain: 'website1-dr.example.ch',
      disasterRecoveryImport: true,
      apply: true,
    });
    expect(asClone.secretsRegenerated).toBe(true);
    const afterClone = parseEnv(await readFile(path.join(paths.secretsDir, 'secrets.env'), 'utf8'));
    expect(afterClone.APP_SECRET).not.toBe(before.APP_SECRET);
  });

  it('restore --apply executes: stop (no -v), DB import, volume extract, health', async () => {
    const base = await lifecycleDeps();
    const d: ActionDeps = { ...base.d, jwtModulusLength: 2048 };
    await installWebsite1(d);
    const backup = await instanceBackup(d, 'website1');

    const res = await instanceRestore(d, 'website1', backup.backupId, { mode: 'same_instance', apply: true });
    expect(res.executed).toBe(true);
    expect(res.health?.overall).toBe('healthy');
    // same-version restore restores the point-in-time compose -> no forward migration
    expect(res.migrated).toBe(false);

    // The database dump was imported and all three persistent volumes restored.
    expect(base.imported).toContain('database.sql');
    expect(base.extracted.map((e) => e.volumeName)).toEqual(
      expect.arrayContaining([
        'selfhelp_website1_uploads',
        'selfhelp_website1_plugin_artifacts',
        'selfhelp_website1_plugin_artifacts_public',
      ]),
    );
    // Restore quiesces with `stop` and never tears volumes down with `-v`.
    const website1Dir = instancePaths('website1', root).dir;
    const restoreCalls = base.runner.calls.filter((c) => c.cwd === website1Dir);
    expect(restoreCalls.some((c) => c.args[0] === 'stop')).toBe(true);
    expect(restoreCalls.some((c) => c.args.includes('-v') || c.args.includes('--volumes'))).toBe(false);
  });

  it('restore --apply re-mounts plugins from the restored snapshot (no half-restored state)', async () => {
    // Regression: a restore of a backup that had plugins used to leave the
    // instance half-restored — the DB lists the plugins as installed and the
    // plugin volumes are repopulated, but the freshly recreated Symfony
    // containers start WITHOUT the composer bundles, so the host reported
    // "plugin could not be mounted / runtime import failed". The restore must
    // re-extract the composer-state snapshot (restored onto the plugin volume)
    // into backend/worker/scheduler and restart them, exactly like an
    // address/mailer/env recreate.
    const base = await lifecycleDeps();
    const d: ActionDeps = { ...base.d, jwtModulusLength: 2048 };
    await installWebsite1(d);
    const backup = await instanceBackup(d, 'website1');

    const website1Dir = instancePaths('website1', root).dir;
    // After recreate the backend's marker file is gone (fresh writable layer)
    // but the snapshot tar was restored onto the plugin volume.
    const remountRunner = new RecordingComposeRunner((args: string[]): ComposeResult => {
      const joined = args.join(' ');
      if (joined.includes('mysqldump')) return { stdout: '-- dump\n', stderr: '' };
      if (joined.includes('test -f') && joined.includes('selfhelp.plugins.lock.json')) {
        return { stdout: 'no\n', stderr: '' };
      }
      if (joined.includes('test -f') && joined.includes('composer-state-')) {
        return { stdout: 'yes\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    d.runner = remountRunner;

    const res = await instanceRestore(d, 'website1', backup.backupId, { mode: 'same_instance', apply: true });
    expect(res.executed).toBe(true);
    expect(res.pluginsRemounted).toBe(true);

    const calls = remountRunner.calls.filter((c) => c.cwd === website1Dir);
    const extractCalls = calls.filter(
      (c) => c.args.join(' ').includes('tar -xf') && c.args.join(' ').includes('composer-state-'),
    );
    expect(extractCalls.some((c) => c.args.includes('backend'))).toBe(true);
    expect(extractCalls.some((c) => c.args.includes('worker'))).toBe(true);
    expect(extractCalls.some((c) => c.args.includes('scheduler'))).toBe(true);
    expect(calls.some((c) => c.args[0] === 'restart' && c.args.includes('backend'))).toBe(true);
  });

  it('restore --apply refuses a corrupted backup BEFORE the stack is touched (integrity gate)', async () => {
    const base = await lifecycleDeps();
    const d: ActionDeps = { ...base.d, jwtModulusLength: 2048 };
    await installWebsite1(d);
    const backup = await instanceBackup(d, 'website1');

    // Tamper with the dump after the manifest hashes were recorded.
    await writeFile(path.join(backup.backupDir, 'database.sql'), '-- tampered bytes --');

    const website1Dir = instancePaths('website1', root).dir;
    const callsBefore = base.runner.calls.filter((c) => c.cwd === website1Dir).length;

    const res = await instanceRestore(d, 'website1', backup.backupId, { mode: 'same_instance', apply: true });
    expect(res.validation.ok).toBe(false);
    expect(res.validation.errors.join(' ')).toContain('Checksum mismatch: database.sql');
    expect(res.plan).toBeNull();
    expect(res.executed).toBeUndefined();

    // The running stack was never quiesced, nothing was imported or extracted.
    const callsDuringRestore = base.runner.calls.filter((c) => c.cwd === website1Dir).slice(callsBefore);
    expect(callsDuringRestore.some((c) => c.args[0] === 'stop')).toBe(false);
    expect(base.imported).toHaveLength(0);
    expect(base.extracted).toHaveLength(0);
  });

  it('restore --apply that dies on the DB import leaves the instance recoverable and a retry succeeds', async () => {
    const base = await lifecycleDeps();
    const d: ActionDeps = { ...base.d, jwtModulusLength: 2048 };
    await installWebsite1(d);
    const backup = await instanceBackup(d, 'website1');

    // Make the instance state distinguishable from the backed-up state, so we
    // can prove the failed attempt never wrote the restored manifest.
    const manifestStore = new ManifestStore('website1', root);
    const current = await manifestStore.read();
    await manifestStore.write({ ...current, displayName: 'Renamed AFTER the backup' });

    // The import fails on every retry attempt of the first restore call.
    let failImports = true;
    d.importDatabase = async (_instanceDir, sqlFile) => {
      if (failImports) throw new Error('server has gone away');
      base.imported.push(path.basename(sqlFile));
    };

    await expect(
      instanceRestore(d, 'website1', backup.backupId, { mode: 'same_instance', apply: true }),
    ).rejects.toThrow(/Database import failed after 3 attempts: server has gone away/);

    // Recoverable: no volume was removed, `-v` was never used, and the
    // manifest/lock were NOT overwritten by the failed attempt.
    expect(base.removedVolumes).toHaveLength(0);
    const website1Dir = instancePaths('website1', root).dir;
    const calls = base.runner.calls.filter((c) => c.cwd === website1Dir);
    expect(calls.some((c) => c.args.includes('-v') || c.args.includes('--volumes'))).toBe(false);
    expect((await manifestStore.read()).displayName).toBe('Renamed AFTER the backup');

    // Once the database answers again, the SAME backup restores cleanly.
    failImports = false;
    const retry = await instanceRestore(d, 'website1', backup.backupId, { mode: 'same_instance', apply: true });
    expect(retry.executed).toBe(true);
    expect(retry.health?.overall).toBe('healthy');
    expect(base.imported).toContain('database.sql');
    // The successful retry applied the point-in-time manifest from the backup.
    expect((await manifestStore.read()).displayName).toBe('Website 1');
  });

  it('clone --apply copies the source into an isolated target and leaves the source untouched', async () => {
    const base = await lifecycleDeps();
    const d: ActionDeps = { ...base.d, jwtModulusLength: 2048 };
    await installWebsite1(d);

    const sourceDir = instancePaths('website1', root).dir;
    const sourceCallsBefore = base.runner.calls.filter((c) => c.cwd === sourceDir).length;

    const res = await instanceClone(d, 'website1', 'website1-staging', {
      targetDomain: 'website1-staging.example.ch',
      apply: true,
    });
    expect(res.executed).toBe(true);
    expect(res.health?.overall).toBe('healthy');

    // The clone is registered in the inventory and pins the source's versions.
    const list = await instanceList(d);
    expect(list.find((i) => i.instanceId === 'website1-staging')?.status).toBe('active');
    const sourceLock = await new LockStore('website1', root).read();
    const cloneLock = await new LockStore('website1-staging', root).read();
    expect(cloneLock.core.version).toBe(sourceLock.core.version);
    expect(cloneLock.core.backendImageDigest).toBe(sourceLock.core.backendImageDigest);

    // Uploads + both plugin volumes were copied into the target's volumes.
    expect(base.copied.map((c) => `${c.from}->${c.to}`)).toEqual(
      expect.arrayContaining([
        'selfhelp_website1_uploads->selfhelp_website1-staging_uploads',
        'selfhelp_website1_plugin_artifacts->selfhelp_website1-staging_plugin_artifacts',
        'selfhelp_website1_plugin_artifacts_public->selfhelp_website1-staging_plugin_artifacts_public',
      ]),
    );
    expect(base.imported).toContain('clone-source.sql');

    // The SOURCE was only read (a mysqldump exec); it was never stopped/downed/recreated.
    const sourceCalls = base.runner.calls.filter((c) => c.cwd === sourceDir).slice(sourceCallsBefore);
    expect(sourceCalls.every((c) => c.args[0] === 'exec')).toBe(true);
    expect(sourceCalls.some((c) => ['stop', 'down', 'up'].includes(c.args[0]!))).toBe(false);
  });

  describe('outbound mail (set-mailer / get-mailer)', () => {
    const DSN = 'smtp://mailuser:s3cret-pw@mail.example.org:587';
    const REDACTED = 'smtp://***@mail.example.org:587';

    it('reports "not configured" on a fresh install (Mailpit/image default applies)', async () => {
      const { d } = await lifecycleDeps();
      await installWebsite1(d);
      expect(await instanceGetMailer(d, 'website1')).toEqual({ configured: false });
    });

    it('set-mailer stores the DSN in secrets.env, recreates the stack, and only ever returns it redacted', async () => {
      const base = await lifecycleDeps();
      await installWebsite1(base.d);
      const paths = instancePaths('website1', root);
      const callsBefore = base.runner.calls.filter((c) => c.cwd === paths.dir).length;

      const res = await instanceSetMailer(base.d, 'website1', { dsn: DSN });
      expect(res.configured).toBe(true);
      expect(res.restarted).toBe(true);
      expect(res.redactedDsn).toBe(REDACTED);
      // The credential never leaves through ANY returned field.
      expect(JSON.stringify(res)).not.toContain('s3cret-pw');

      // Raw DSN only in the 0600 secrets.env; the non-secret .env keeps Mailpit.
      const secretEnv = parseEnv(await readFile(path.join(paths.secretsDir, 'secrets.env'), 'utf8'));
      expect(secretEnv.MAILER_DSN).toBe(DSN);
      const dotenv = await readFile(path.join(paths.dir, '.env'), 'utf8');
      expect(dotenv).toContain('MAILER_DSN=smtp://mailpit:1025');
      expect(dotenv).not.toContain('s3cret-pw');

      // The stack was recreated so backend/worker/scheduler pick the DSN up.
      const calls = base.runner.calls.filter((c) => c.cwd === paths.dir).slice(callsBefore);
      expect(calls.some((c) => c.args[0] === 'up')).toBe(true);

      expect(await instanceGetMailer(base.d, 'website1')).toEqual({
        configured: true,
        redactedDsn: REDACTED,
      });
    });

    it('refuses a schemeless DSN and an empty call without touching the secrets', async () => {
      const { d } = await lifecycleDeps();
      await installWebsite1(d);
      await expect(instanceSetMailer(d, 'website1', { dsn: 'mail.example.org:587' })).rejects.toThrow(
        /not a valid mailer DSN/,
      );
      await expect(instanceSetMailer(d, 'website1', {})).rejects.toThrow(/Provide a mailer DSN/);

      const paths = instancePaths('website1', root);
      const secretEnv = parseEnv(await readFile(path.join(paths.secretsDir, 'secrets.env'), 'utf8'));
      expect(secretEnv.MAILER_DSN).toBeUndefined();
      expect(await instanceGetMailer(d, 'website1')).toEqual({ configured: false });
    });

    it('--clear falls back to Mailpit and --no-restart leaves the stack alone', async () => {
      const base = await lifecycleDeps();
      await installWebsite1(base.d);
      await instanceSetMailer(base.d, 'website1', { dsn: DSN });

      const paths = instancePaths('website1', root);
      const callsBefore = base.runner.calls.filter((c) => c.cwd === paths.dir).length;
      const res = await instanceSetMailer(base.d, 'website1', { clear: true, restart: false });
      expect(res).toEqual({ configured: false, restarted: false });

      // The override is gone from secrets.env, so the non-secret Mailpit
      // default (loaded first) applies again.
      const secretEnv = parseEnv(await readFile(path.join(paths.secretsDir, 'secrets.env'), 'utf8'));
      expect(secretEnv.MAILER_DSN).toBeUndefined();
      const dotenv = await readFile(path.join(paths.dir, '.env'), 'utf8');
      expect(dotenv).toContain('MAILER_DSN=smtp://mailpit:1025');

      // --no-restart: not a single compose command ran.
      expect(base.runner.calls.filter((c) => c.cwd === paths.dir).length).toBe(callsBefore);
      expect(await instanceGetMailer(base.d, 'website1')).toEqual({ configured: false });
    });
  });

  describe('environment editor (set-env / get-env)', () => {
    it('persists operator overrides to .env + manifest and recreates the stack', async () => {
      const base = await lifecycleDeps();
      await installWebsite1(base.d);
      const paths = instancePaths('website1', root);
      const callsBefore = base.runner.calls.filter((c) => c.cwd === paths.dir).length;

      const res = await instanceSetEnv(base.d, 'website1', {
        overrides: { JWT_TOKEN_TTL: '7200', MY_FEATURE_FLAG: 'on' },
      });
      expect(res.applied).toBe(2);
      expect(res.restarted).toBe(true);

      // The generated .env carries the overrides; structural keys stay correct.
      const dotenv = parseEnv(await readFile(paths.envPath, 'utf8'));
      expect(dotenv.JWT_TOKEN_TTL).toBe('7200');
      expect(dotenv.MY_FEATURE_FLAG).toBe('on');
      expect(dotenv.SELFHELP_INSTANCE_ID).toBe('website1');

      // Persisted on the manifest so they survive future regenerations.
      const manifest = await new ManifestStore('website1', root).read();
      expect(manifest.envOverrides).toEqual({ JWT_TOKEN_TTL: '7200', MY_FEATURE_FLAG: 'on' });

      // Stack recreated so every service reloads the env.
      const calls = base.runner.calls.filter((c) => c.cwd === paths.dir).slice(callsBefore);
      expect(calls.some((c) => c.args[0] === 'up')).toBe(true);

      // get-env reflects the override and classifies managed keys read-only.
      const cfg = await instanceGetEnv(base.d, 'website1');
      expect(cfg.entries.find((e) => e.key === 'JWT_TOKEN_TTL')).toMatchObject({
        value: '7200',
        managed: false,
        overridden: true,
      });
      expect(cfg.entries.find((e) => e.key === 'MY_FEATURE_FLAG')).toMatchObject({ custom: true });
      expect(cfg.entries.find((e) => e.key === 'SELFHELP_INSTANCE_ID')?.managed).toBe(true);
    });

    it('survives an address change (overrides re-merged into the regenerated .env)', async () => {
      const base = await lifecycleDeps();
      await installWebsite1(base.d);
      await instanceSetEnv(base.d, 'website1', { overrides: { JWT_TOKEN_TTL: '7200' }, restart: false });

      await instanceSetAddress(base.d, 'website1', { domain: 'moved.example.ch', restart: false });

      const paths = instancePaths('website1', root);
      const dotenv = parseEnv(await readFile(paths.envPath, 'utf8'));
      expect(dotenv.JWT_TOKEN_TTL).toBe('7200');
      // The address-derived key tracked the new domain (override didn't freeze it).
      expect(dotenv.FRONTEND_BASE_URL).toBe('https://moved.example.ch');
    });

    it('refuses manager-controlled keys and invalid names without touching the instance', async () => {
      const base = await lifecycleDeps();
      await installWebsite1(base.d);
      const paths = instancePaths('website1', root);
      const callsBefore = base.runner.calls.filter((c) => c.cwd === paths.dir).length;

      await expect(
        instanceSetEnv(base.d, 'website1', { overrides: { SELFHELP_INSTANCE_ID: 'evil' } }),
      ).rejects.toThrow(/managed by the manager/);
      await expect(
        instanceSetEnv(base.d, 'website1', { overrides: { MAILER_DSN: 'smtp://x' } }),
      ).rejects.toThrow(/outbound-email settings/);
      await expect(
        instanceSetEnv(base.d, 'website1', { overrides: { '1BAD': 'x' } }),
      ).rejects.toThrow(/not a valid environment variable name/);

      // Nothing ran and no overrides were persisted.
      expect(base.runner.calls.filter((c) => c.cwd === paths.dir).length).toBe(callsBefore);
      expect((await new ManifestStore('website1', root).read()).envOverrides).toBeUndefined();
    });
  });
});

describe('instance repair + broken-instance forgiveness', () => {
  const respondDump = (args: string[]): ComposeResult =>
    args.join(' ').includes('mysqldump') ? { stdout: '-- dump\n', stderr: '' } : { stdout: '', stderr: '' };

  async function repairDeps(): Promise<ActionDeps> {
    const base = await makeDeps();
    return {
      ...base,
      runner: new RecordingComposeRunner(respondDump),
      archiveVolume: async (_v, outFile) => {
        await writeFile(outFile, 'archive-bytes');
      },
    };
  }

  async function installWebsite1(d: ActionDeps): Promise<void> {
    await serverInit(d, { serverId: 's1', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(d, {
      instanceId: 'website1',
      displayName: 'Website 1',
      mode: 'production',
      domain: 'website1.example.ch',
      registryUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
      version: 'latest',
    });
  }

  it('list marks a registered instance with a missing manifest as broken instead of crashing', async () => {
    const d = await repairDeps();
    await installWebsite1(d);
    await rm(instancePaths('website1', root).manifestPath);

    const rows = await instanceList(d);
    expect(rows.find((r) => r.instanceId === 'website1')?.status).toBe('broken');
  });

  it('list surfaces an on-disk instance directory the inventory does not know about', async () => {
    const d = await repairDeps();
    await installWebsite1(d);
    await mkdir(path.join(root, 'instances', 'stray1'), { recursive: true });
    await writeFile(path.join(root, 'instances', 'stray1', 'compose.yaml'), 'services: {}\n');
    // A folder holding only retained backups (full_delete leftovers) is NOT an instance.
    await mkdir(path.join(root, 'instances', 'gone1', 'backups'), { recursive: true });

    const rows = await instanceList(d);
    expect(rows.find((r) => r.instanceId === 'stray1')?.status).toBe('broken');
    expect(rows.find((r) => r.instanceId === 'gone1')).toBeUndefined();
  });

  it('id-taking actions explain a missing manifest instead of throwing raw ENOENT', async () => {
    const d = await repairDeps();
    await installWebsite1(d);
    await rm(instancePaths('website1', root).manifestPath);

    const err = await instanceHealth(d, 'website1').then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toContain('not found in this state root');
    expect(err).toContain(root);
    expect(err).toContain('website1');
    expect(err).toContain('sh-manager instance repair website1');
    expect(err).not.toContain('ENOENT');
  });

  it('repair restores the manifest from the newest backup snapshot when available', async () => {
    const d = await repairDeps();
    await installWebsite1(d);
    const original = await new ManifestStore('website1', root).read();
    await instanceBackup(d, 'website1');
    await rm(instancePaths('website1', root).manifestPath);

    const res = await instanceRepair(d, 'website1');
    expect(res.repaired).toBe(true);
    expect(res.source).toBe('backup');
    const restored = await new ManifestStore('website1', root).read();
    expect(restored.displayName).toBe(original.displayName);
    expect(restored.versions).toEqual(original.versions);
    expect((await instanceList(d)).find((r) => r.instanceId === 'website1')?.status).toBe('active');
  });

  it('repair reconstructs the manifest from inventory + lock + compose when no backup exists', async () => {
    const d = await repairDeps();
    await installWebsite1(d);
    const original = await new ManifestStore('website1', root).read();
    await rm(instancePaths('website1', root).manifestPath);

    const res = await instanceRepair(d, 'website1');
    expect(res.repaired).toBe(true);
    expect(res.source).toBe('reconstructed');
    const rebuilt = await new ManifestStore('website1', root).read();
    expect(rebuilt.domain).toBe('website1.example.ch');
    expect(rebuilt.mode).toBe('production');
    expect(rebuilt.versions.selfhelp).toBe(original.versions.selfhelp);
    expect(rebuilt.images).toEqual(original.images);
    expect(rebuilt.routing.publicFrontendUrl).toBe('https://website1.example.ch');
    expect((await instanceList(d)).find((r) => r.instanceId === 'website1')?.status).toBe('active');
  });

  it('repair re-registers an intact instance the inventory lost', async () => {
    const d = await repairDeps();
    await installWebsite1(d);
    const invPath = serverInventoryPath(root);
    const inv = JSON.parse(await readFile(invPath, 'utf8')) as { instances: { instanceId: string }[] };
    inv.instances = inv.instances.filter((i) => i.instanceId !== 'website1');
    await writeFile(invPath, JSON.stringify(inv, null, 2));
    expect((await instanceList(d)).find((r) => r.instanceId === 'website1')?.status).toBe('broken');

    const res = await instanceRepair(d, 'website1');
    expect(res.repaired).toBe(true);
    expect(res.source).toBe('intact');
    expect((await instanceList(d)).find((r) => r.instanceId === 'website1')?.status).toBe('active');
  });

  it('repair is a no-op on a healthy instance and refuses a fully deleted one', async () => {
    const d = await repairDeps();
    await installWebsite1(d);

    const healthy = await instanceRepair(d, 'website1');
    expect(healthy.repaired).toBe(false);
    expect(healthy.source).toBe('intact');

    await expect(instanceRepair(d, 'ghost')).rejects.toThrow(/nothing to repair/);
  });

  it('repair backfills a missing manager token on a pre-token instance (manifest intact)', async () => {
    const d = await repairDeps();
    await installWebsite1(d);
    const secretsEnv = path.join(instancePaths('website1', root).secretsDir, 'secrets.env');
    const before = await readFile(secretsEnv, 'utf8');
    expect(before).toMatch(/SELFHELP_MANAGER_TOKEN=.+/);
    // Simulate an instance installed before the token existed.
    await writeFile(
      secretsEnv,
      before
        .split('\n')
        .filter((line) => !line.startsWith('SELFHELP_MANAGER_TOKEN='))
        .join('\n'),
    );

    const res = await instanceRepair(d, 'website1');
    expect(res.repaired).toBe(true);
    expect(res.source).toBe('intact');
    expect(res.notes.join(' ')).toContain('SELFHELP_MANAGER_TOKEN');
    const after = await readFile(secretsEnv, 'utf8');
    expect(after).toMatch(/SELFHELP_MANAGER_TOKEN=.+/);

    // Existing secrets are never changed, and a second repair is a no-op.
    const tokenLine = (text: string): string | undefined =>
      text.split('\n').find((line) => line.startsWith('MYSQL_PASSWORD='));
    expect(tokenLine(after)).toBe(tokenLine(before));
    const again = await instanceRepair(d, 'website1');
    expect(again.repaired).toBe(false);
  });
});

describe('output formatting', () => {
  it('formats a table', () => {
    const t = formatTable(['A', 'B'], [['1', '22'], ['333', '4']]);
    expect(t.split('\n')).toHaveLength(4);
  });
  it('formats preflight + health', () => {
    expect(formatPreflight({
      preflightVersion: 1, status: 'ok', instanceId: 'x', currentVersion: '1', targetVersion: '2',
      checks: [{ code: 'c', severity: 'info', message: 'm' }], options: [],
      database: { destructive: false, requiresBackup: true, manualConfirmationRequired: false },
      rollback: { automaticBeforeMigrations: true, automaticAfterDestructiveMigrations: false },
    })).toContain('[OK]');
    expect(formatHealth({ instanceId: 'x', overall: 'healthy', services: [{ service: 'backend', state: 'healthy', required: true }], checkedAt: 'now' })).toContain('HEALTHY');
  });
});
