// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrustedKeysFile } from '@shm/schemas';
import { RecordingComposeRunner, type ComposeResult } from '@shm/docker';
import type { Fetcher, FetchResponse } from '@shm/registry';
import {
  LockStore,
  ManifestStore,
  generateInstanceSecrets,
  instancePaths,
  writeInstanceSecrets,
} from '@shm/instances';
import type { ActionDeps } from './actions.js';
import {
  doctor,
  instanceBackup,
  instanceClone,
  instanceInstall,
  instanceList,
  instanceRemove,
  instanceRestore,
  instanceSupportBundle,
  serverInit,
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

  it('clone produces an isolated plan that pins the source versions', async () => {
    const { d } = await lifecycleDeps();
    await installWebsite1(d);
    const res = await instanceClone(d, 'website1', 'website1-staging', { targetDomain: 'website1-staging.example.ch' });
    expect(res.plan.targetInstanceId).toBe('website1-staging');
    expect(res.plan.generateNewSecrets).toBe(true);
    expect(res.plan.steps.length).toBeGreaterThan(0);
    expect(formatSteps('Clone:', res.plan.steps)).toContain('Clone:');
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
