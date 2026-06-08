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
    'selfhelp-core-8.0.0.json': await readExample('core-release.json'),
    'selfhelp-frontend-8.0.0.json': await readExample('frontend-release.json'),
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
    expect(res.version).toBe('8.0.0');
    const manifest = await new ManifestStore('website1', root).read();
    const lock = await new LockStore('website1', root).read();
    expect(manifest.images.frontend).toContain('selfhelp-frontend:8.0.0');
    expect(lock.core.version).toBe('8.0.0');

    const list = await instanceList(d);
    expect(list.map((i) => i.instanceId)).toContain('website1');
  });

  it('doctor reports ok with healthy resources', async () => {
    const d = await makeDeps();
    const pf = await doctor(d, [80, 443]);
    expect(pf.status).toBe('ok');
  });
});

describe('instance lifecycle (offline)', () => {
  /** A deps variant whose runner answers mysqldump and that can archive/remove volumes. */
  async function lifecycleDeps(): Promise<{ d: ActionDeps; removedVolumes: string[] }> {
    const base = await makeDeps();
    const removedVolumes: string[] = [];
    const respond = (args: string[]): ComposeResult =>
      args.join(' ').includes('mysqldump') ? { stdout: '-- dump\n', stderr: '' } : { stdout: '', stderr: '' };
    const d: ActionDeps = {
      ...base,
      runner: new RecordingComposeRunner(respond),
      archiveVolume: async (_volumeName, outFile) => {
        await writeFile(outFile, 'archive-bytes');
      },
      removeVolumes: async (names) => {
        removedVolumes.push(...names);
      },
    };
    return { d, removedVolumes };
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
