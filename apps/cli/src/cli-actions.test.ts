// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Server bootstrap + instance install / list / health / doctor actions (offline).
 *
 * Split out of the original monolithic `cli.test.ts`; the shared offline
 * {@link ActionDeps} builder + fixtures live in `cli-test-support`. The test
 * bodies are unchanged.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrustedKeysFile } from '@shm/schemas';
import { RecordingComposeRunner, type ComposeResult } from '@shm/docker';
import { LockStore, ManifestStore, instancePaths } from '@shm/instances';
import { doctor, instanceInstall, instanceList, serverInit, serverStartProxy, serverProxyLogs, ensureProxyRunning } from '@shm/app-actions';
import type { ActionDeps } from '@shm/app-actions';
import { buildActionDeps, readExample } from './cli-test-support.js';

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

const makeDeps = (): Promise<ActionDeps> => buildActionDeps({ root, trustedKeys, runner });

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
