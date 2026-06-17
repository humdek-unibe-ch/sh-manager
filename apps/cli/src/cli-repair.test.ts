// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance repair + broken-instance forgiveness (offline).
 *
 * Split out of the original monolithic `cli.test.ts`; the shared offline
 * {@link ActionDeps} builder + fixtures live in `cli-test-support`. The test
 * bodies are unchanged.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrustedKeysFile } from '@shm/schemas';
import { RecordingComposeRunner, type ComposeResult } from '@shm/docker';
import { ManifestStore, instancePaths, serverInventoryPath } from '@shm/instances';
import { instanceBackup, instanceHealth, instanceInstall, instanceList, instanceRepair, serverInit } from '@shm/app-actions';
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
