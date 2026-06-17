// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordingComposeRunner, type ComposeResult } from '@shm/docker';
import { ManifestStore } from '@shm/instances';
import type { InstanceManifest } from '@shm/schemas';
import { instancePluginRecover, instanceSafeMode, type ActionDeps } from './actions.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-recover-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const manifest: InstanceManifest = {
  manifestVersion: 1,
  instanceId: 'website1',
  displayName: 'Website 1',
  domain: 'website1.example.ch',
  mode: 'production',
  createdAt: '2026-06-05T10:00:00+00:00',
  updatedAt: '2026-06-05T10:00:00+00:00',
  registry: { id: 'selfhelp-official', url: 'https://registry.example/', channel: 'stable' },
  versions: { selfhelp: '1.4.2', backend: '1.4.2', frontend: '1.4.2', scheduler: '1.4.2', worker: '1.4.2', pluginApi: '2.1' },
  images: {
    backend: 'b', frontend: 'f', scheduler: 's', worker: 'w',
    mysql: 'mysql:8.4', redis: 'redis:7.2', mercure: 'dunglas/mercure:0.18',
  },
  routing: {
    publicFrontendUrl: 'https://website1.example.ch',
    browserApiPrefix: '/api',
    internalSymfonyUrl: 'http://backend:8080',
    symfonyApiPrefix: '/cms-api/v1',
  },
  installedPlugins: [],
};

async function writeManifest(): Promise<void> {
  await new ManifestStore('website1', root).write(manifest);
}

function depsWith(runner: RecordingComposeRunner): ActionDeps {
  return { root, runner } as unknown as ActionDeps;
}

// The drain finds nothing to do (we exercise the safe-mode + repair + probe
// orchestration; finalizePluginOperations is unit-tested in @shm/core).
const emptyClient = {
  listPendingOperations: async () => [],
  listInstalledPlugins: async () => [],
};

const isConsole = (args: string[]): boolean => args.includes('bin/console');
const joinedArgs = (runner: RecordingComposeRunner): string[] => runner.calls.map((c) => c.args.join(' '));

describe('instancePluginRecover (half-removed plugin / dangling bundle)', () => {
  it('recovers: safe mode -> drain -> repair -> a clean boot probe succeeds, then leaves safe mode off', async () => {
    await writeManifest();
    const runner = new RecordingComposeRunner((): ComposeResult => ({ stdout: '', stderr: '' }));

    const res = await instancePluginRecover(depsWith(runner), 'website1', { drainOverrides: { client: emptyClient } });

    expect(res.recovered).toBe(true);
    expect(res.safeModeLeftEnabled).toBe(false);
    const calls = joinedArgs(runner);
    expect(calls.some((a) => a.includes('selfhelp:safe-mode --enable'))).toBe(true);
    expect(calls.some((a) => a.includes('selfhelp:plugin:repair'))).toBe(true);
    expect(calls.some((a) => a.includes('selfhelp:safe-mode --disable'))).toBe(true);
    expect(calls.some((a) => a.endsWith('bin/console about'))).toBe(true); // the boot probe
    expect(calls.filter((a) => a === 'restart backend').length).toBeGreaterThanOrEqual(2);
  });

  it('kernel dead: creates the safe-mode marker over a shell and keeps the instance UP when the probe still fatals', async () => {
    await writeManifest();
    // Every kernel boot fatals (the dangling-bundle state); only shell commands succeed.
    const runner = new RecordingComposeRunner((args: string[]): ComposeResult => {
      if (isConsole(args)) throw new Error('PHP Fatal error: Uncaught Error: Class "Humdek\\SurveyJsBundle\\HumdekSurveyJsBundle" not found');
      return { stdout: '', stderr: '' };
    });

    const res = await instancePluginRecover(depsWith(runner), 'website1', { drainOverrides: { client: emptyClient } });

    expect(res.recovered).toBe(false);
    expect(res.safeModeLeftEnabled).toBe(true); // kept up in safe mode rather than crash-looping
    const calls = joinedArgs(runner);
    expect(calls.some((a) => a.includes('selfhelp:safe-mode --enable'))).toBe(true); // tried the console first
    expect(calls.some((a) => a.includes(': > /app/var/plugin_safe_mode.lock'))).toBe(true); // fell back to the marker
    expect(calls.some((a) => a.endsWith('bin/console about'))).toBe(true); // probe attempted
  });

  it('keepSafeMode leaves safe mode enabled and never probes a plugins-on boot', async () => {
    await writeManifest();
    const runner = new RecordingComposeRunner((): ComposeResult => ({ stdout: '', stderr: '' }));

    const res = await instancePluginRecover(depsWith(runner), 'website1', {
      keepSafeMode: true,
      drainOverrides: { client: emptyClient },
    });

    expect(res.safeModeLeftEnabled).toBe(true);
    const calls = joinedArgs(runner);
    expect(calls.some((a) => a.includes('selfhelp:safe-mode --disable'))).toBe(false);
    expect(calls.some((a) => a.endsWith('bin/console about'))).toBe(false);
  });
});

describe('instanceSafeMode resilience', () => {
  it('falls back to creating the marker file directly when the console cannot boot', async () => {
    const runner = new RecordingComposeRunner((args: string[]): ComposeResult => {
      if (isConsole(args)) throw new Error('kernel boot failed');
      return { stdout: '', stderr: '' };
    });
    await instanceSafeMode(depsWith(runner), 'website1', true);
    const calls = joinedArgs(runner);
    expect(calls.some((a) => a.includes('selfhelp:safe-mode --enable'))).toBe(true); // tried console
    expect(calls.some((a) => a.includes('mkdir -p /app/var && : > /app/var/plugin_safe_mode.lock'))).toBe(true); // fell back
  });

  it('uses the plain console command when the kernel boots (no shell fallback)', async () => {
    const runner = new RecordingComposeRunner((): ComposeResult => ({ stdout: '', stderr: '' }));
    await instanceSafeMode(depsWith(runner), 'website1', false);
    const calls = joinedArgs(runner);
    expect(calls.some((a) => a.includes('selfhelp:safe-mode --disable'))).toBe(true);
    expect(calls.some((a) => a.includes('plugin_safe_mode.lock'))).toBe(false);
  });
});
