// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  PLUGIN_STATE_MARKER,
  finalizePluginOperations,
  pluginStateSnapshotPath,
  reinstallPluginsForCore,
  restorePluginStateIfNeeded,
  type InstalledPluginRecord,
  type PendingPluginOperation,
  type PluginExecDeps,
  type SymfonyService,
} from './plugin-state.js';

interface RecordedCall {
  service: SymfonyService;
  cmd: string;
  user?: string;
  env?: Record<string, string>;
}

interface FakeOptions {
  /** Backend still carries the finalized plugin state (default true). */
  markerPresent?: boolean;
  /** A composer-state snapshot exists on the shared volume (default false). */
  snapshotPresent?: boolean;
  /** A promoted archive package dir exists on the plugin volume (default false). */
  archiveDirPresent?: boolean;
  /** Throw for any command whose joined string matches. */
  failMatching?: { pattern: RegExp; message: string };
}

function fake(opts: FakeOptions = {}): { deps: PluginExecDeps; calls: RecordedCall[]; restarts: string[][]; logs: string[] } {
  const calls: RecordedCall[] = [];
  const restarts: string[][] = [];
  const logs: string[] = [];
  const deps: PluginExecDeps = {
    exec: async (service, cmd, execOpts) => {
      const joined = cmd.join(' ');
      calls.push({ service, cmd: joined, ...(execOpts?.user ? { user: execOpts.user } : {}), ...(execOpts?.env ? { env: execOpts.env } : {}) });
      if (opts.failMatching && opts.failMatching.pattern.test(joined)) {
        throw new Error(opts.failMatching.message);
      }
      if (joined.includes(`test -f ${PLUGIN_STATE_MARKER}`)) {
        return (opts.markerPresent ?? true) ? 'yes' : 'no';
      }
      if (joined.includes('test -f ') && joined.includes('.shm-composer-state')) {
        return (opts.snapshotPresent ?? false) ? 'yes' : 'no';
      }
      if (joined.includes('test -d ') && joined.includes('installed/backend/package')) {
        return (opts.archiveDirPresent ?? false) ? 'yes' : 'no';
      }
      return '';
    },
    restart: async (services) => {
      restarts.push([...services]);
    },
    log: (line) => {
      logs.push(line);
    },
  };
  return { deps, calls, restarts, logs };
}

const installOp: PendingPluginOperation = {
  operationId: 7,
  pluginId: 'sh2-shp-survey-js',
  type: 'install',
  package: 'humdek/sh2-shp-survey-js',
  version: '0.2.22',
  repository: { type: 'vcs', url: 'https://github.com/humdek-unibe-ch/sh2-shp-survey-js.git' },
  archiveStagingDir: '/app/var/plugins/sh2-shp-survey-js-0.2.22/staging',
};

describe('finalizePluginOperations', () => {
  it('runs composer + finalize + enable in the backend, then snapshots, syncs worker/scheduler and restarts', async () => {
    const { deps, calls, restarts } = fake();
    const report = await finalizePluginOperations({ operations: [installOp], coreVersion: '0.4.2' }, deps);

    expect(report.outcomes).toEqual([
      { operationId: 7, pluginId: 'sh2-shp-survey-js', type: 'install', status: 'done' },
    ]);
    expect(report.restarted).toBe(true);

    // /app handed to www-data in every Symfony service (finalize writes the
    // lock file via rename() into /app).
    const prepServices = calls.filter((c) => c.cmd.includes('chgrp www-data /app')).map((c) => c.service);
    expect(prepServices).toEqual(expect.arrayContaining(['backend', 'worker', 'scheduler']));
    for (const prep of calls.filter((c) => c.cmd.includes('chgrp www-data /app'))) {
      expect(prep.user).toBe('0');
    }

    const backendCmds = calls.filter((c) => c.service === 'backend').map((c) => c.cmd);
    const gitIdx = backendCmds.findIndex((c) => c.includes('command -v git'));
    const repoIdx = backendCmds.findIndex((c) => c.startsWith('composer config repositories.shm-sh2-shp-survey-js'));
    const requireIdx = backendCmds.findIndex((c) => c.startsWith('composer require humdek/sh2-shp-survey-js:0.2.22'));
    const promoteIdx = backendCmds.findIndex((c) => c.includes('/app/public/plugin-artifacts/sh2-shp-survey-js-0.2.22'));
    const finalizeIdx = backendCmds.findIndex((c) => c.includes('selfhelp:plugin:run-operation 7'));
    const enableIdx = backendCmds.findIndex((c) => c.includes('selfhelp:plugin:enable sh2-shp-survey-js'));
    const snapshotIdx = backendCmds.findIndex((c) => c.includes('tar -cf'));
    expect(gitIdx).toBeGreaterThanOrEqual(0);
    expect(repoIdx).toBeGreaterThan(gitIdx);
    expect(requireIdx).toBeGreaterThan(repoIdx);
    // Staged runtime artifacts (verified by the backend before parking) are
    // promoted to the public web dir BEFORE finalize, so the plugin row never
    // exists without its importable frontend bundle.
    expect(promoteIdx).toBeGreaterThan(requireIdx);
    expect(backendCmds[promoteIdx]).toContain('/app/var/plugins/sh2-shp-survey-js-0.2.22/staging');
    expect(finalizeIdx).toBeGreaterThan(promoteIdx);
    expect(enableIdx).toBeGreaterThan(finalizeIdx);
    expect(snapshotIdx).toBeGreaterThan(enableIdx);
    expect(backendCmds[snapshotIdx]).toContain(pluginStateSnapshotPath('0.4.2'));

    // https vcs repos are registered with no-api so composer uses anonymous
    // git-over-https instead of the rate-limited GitHub API (whose exhaustion
    // falls back to impossible git@github.com SSH clones).
    expect(backendCmds[repoIdx]).toContain('"no-api":true');

    // composer runs with an isolated writable home, never as root.
    const composerCall = calls.find((c) => c.cmd.startsWith('composer require'));
    expect(composerCall?.env?.COMPOSER_HOME).toBe('/tmp/composer');
    expect(composerCall?.user).toBeUndefined();

    // Worker + scheduler are synced from the snapshot, then one restart batch.
    for (const svc of ['worker', 'scheduler'] as const) {
      const extract = calls.find((c) => c.service === svc && c.cmd.includes('tar -xf'));
      expect(extract?.cmd).toContain(pluginStateSnapshotPath('0.4.2'));
    }
    expect(restarts).toEqual([['backend', 'worker', 'scheduler']]);
  });

  it('rebuilds every Symfony cache after the bundles file lands and BEFORE restart so the new plugin route resolves', async () => {
    // Regression for "Failed to load surveys / No route found for GET
    // …/admin/plugins/<id>/surveys" right after a managed install: the prod
    // images warm var/cache lazily and `compose restart` keeps the writable
    // layer, so without a cache rebuild the rebooted kernel reuses the
    // pre-plugin compiled container + router matcher and the plugin's
    // DB-synced routes 404. cache:clear must run in all three services, after
    // their bundles file is in place, and before the restart.
    const { deps, calls, restarts } = fake();
    await finalizePluginOperations({ operations: [installOp], coreVersion: '0.4.2' }, deps);

    for (const svc of ['backend', 'worker', 'scheduler'] as const) {
      const cacheClear = calls.find((c) => c.service === svc && c.cmd.includes('cache:clear'));
      expect(cacheClear, `cache:clear missing for ${svc}`).toBeDefined();
    }

    // Ordering: worker/scheduler get the bundles file (tar -xf) BEFORE their
    // cache:clear, and the whole rebuild completes BEFORE the single restart.
    const flat = calls.map((c) => `${c.service}:${c.cmd}`);
    for (const svc of ['worker', 'scheduler'] as const) {
      const extractIdx = flat.findIndex((c) => c.startsWith(`${svc}:`) && c.includes('tar -xf'));
      const clearIdx = flat.findIndex((c) => c.startsWith(`${svc}:`) && c.includes('cache:clear'));
      expect(extractIdx).toBeGreaterThanOrEqual(0);
      expect(clearIdx).toBeGreaterThan(extractIdx);
    }
    expect(restarts).toEqual([['backend', 'worker', 'scheduler']]);
  });

  it('falls back to deleting the compiled cache when cache:clear fails so the restart still gets a fresh kernel', async () => {
    const { deps, calls } = fake({ failMatching: { pattern: /cache:clear/, message: 'warmup boom' } });
    const report = await finalizePluginOperations({ operations: [installOp], coreVersion: '0.4.2' }, deps);

    // The install itself still succeeds — the cache rebuild is best-effort.
    expect(report.outcomes[0]).toMatchObject({ status: 'done' });
    expect(report.restarted).toBe(true);
    // Every service that failed cache:clear drops its compiled cache instead.
    for (const svc of ['backend', 'worker', 'scheduler'] as const) {
      const fallback = calls.find((c) => c.service === svc && c.cmd.includes('rm -rf var/cache'));
      expect(fallback, `cache fallback missing for ${svc}`).toBeDefined();
    }
  });

  it('uses composer remove for uninstalls and tolerates an already-removed package', async () => {
    const uninstall: PendingPluginOperation = {
      operationId: 9,
      pluginId: 'sh2-shp-survey-js',
      type: 'uninstall',
      package: 'humdek/sh2-shp-survey-js',
      version: null,
      repository: null,
    };
    const { deps, calls } = fake({ failMatching: { pattern: /^composer remove/, message: 'not installed' } });
    const report = await finalizePluginOperations({ operations: [uninstall], coreVersion: '0.4.2' }, deps);

    // The remove failure is tolerated; finalize is the authoritative cleanup.
    expect(report.outcomes[0]).toMatchObject({ operationId: 9, type: 'uninstall', status: 'done' });
    expect(calls.some((c) => c.cmd.includes('selfhelp:plugin:run-operation 9'))).toBe(true);
    // No enable for uninstalls.
    expect(calls.some((c) => c.cmd.includes('selfhelp:plugin:enable'))).toBe(false);
  });

  it('treats a purge like an uninstall on the composer side (remove + finalize, never enable)', async () => {
    const purge: PendingPluginOperation = {
      operationId: 11,
      pluginId: 'sh2-shp-survey-js',
      type: 'purge',
      package: 'humdek/sh2-shp-survey-js',
      version: null,
      repository: null,
    };
    const { deps, calls } = fake();
    const report = await finalizePluginOperations({ operations: [purge], coreVersion: '0.4.2' }, deps);

    expect(report.outcomes[0]).toMatchObject({ operationId: 11, type: 'purge', status: 'done' });
    // Composer REMOVE (not require) — a purge must never try to install.
    expect(calls.some((c) => c.cmd.startsWith('composer remove humdek/sh2-shp-survey-js'))).toBe(true);
    expect(calls.some((c) => c.cmd.startsWith('composer require'))).toBe(false);
    expect(calls.some((c) => c.cmd.includes('selfhelp:plugin:run-operation 11'))).toBe(true);
    // Purge removes; it must never enable the plugin.
    expect(calls.some((c) => c.cmd.includes('selfhelp:plugin:enable'))).toBe(false);
  });

  it('stops at the first failed operation, cancels it in the CMS, and does not restart when nothing finalized', async () => {
    const second: PendingPluginOperation = { ...installOp, operationId: 8, pluginId: 'other-plugin', package: 'humdek/other', version: '1.0.0', repository: null };
    const { deps, calls, restarts } = fake({ failMatching: { pattern: /^composer require/, message: 'rate limited' } });
    const report = await finalizePluginOperations({ operations: [installOp, second], coreVersion: '0.4.2' }, deps);

    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({ operationId: 7, status: 'failed', detail: 'rate limited' });
    expect(report.restarted).toBe(false);
    // The row leaves `running` so the poller does not re-fail it every tick;
    // the operator retries deliberately from the CMS plugins page.
    expect(calls.some((c) => c.cmd.includes('selfhelp:plugin:cancel-operation 7'))).toBe(true);
    // Second operation never attempted; no snapshot/sync/restart of a broken state.
    expect(calls.some((c) => c.cmd.includes('humdek/other'))).toBe(false);
    expect(calls.some((c) => c.cmd.includes('tar -cf'))).toBe(false);
    expect(restarts).toEqual([]);
  });

  it('self-heals a half-finalized operation (duplicate entry) via selfhelp:plugin:repair', async () => {
    const { deps, calls } = fake({
      failMatching: { pattern: /run-operation 7/, message: "SQLSTATE[23000]: Duplicate entry 'sh2-shp-survey-js'" },
    });
    const report = await finalizePluginOperations({ operations: [installOp], coreVersion: '0.4.2' }, deps);

    expect(report.outcomes[0]).toMatchObject({ operationId: 7, status: 'done' });
    expect(calls.some((c) => c.service === 'backend' && c.cmd.includes('selfhelp:plugin:repair'))).toBe(true);
  });

  it('restores the previous snapshot into the backend first when a recreate wiped its state', async () => {
    // Regression: without the pre-drain restore, draining operation N after a
    // container recreate would snapshot ONLY plugin N's vendor state and
    // silently drop every previously installed plugin from worker/scheduler.
    const { deps, calls } = fake({ markerPresent: false, snapshotPresent: true });
    await finalizePluginOperations({ operations: [installOp], coreVersion: '0.4.2' }, deps);

    const backendCmds = calls.filter((c) => c.service === 'backend').map((c) => c.cmd);
    const restoreIdx = backendCmds.findIndex((c) => c.includes('tar -xf'));
    const requireIdx = backendCmds.findIndex((c) => c.startsWith('composer require'));
    expect(restoreIdx).toBeGreaterThanOrEqual(0);
    expect(restoreIdx).toBeLessThan(requireIdx);
  });

  it('does nothing for an empty operations list', async () => {
    const { deps, calls, restarts } = fake();
    const report = await finalizePluginOperations({ operations: [], coreVersion: '0.4.2' }, deps);
    expect(report).toEqual({ outcomes: [], restarted: false });
    expect(calls).toEqual([]);
    expect(restarts).toEqual([]);
  });
});

describe('reinstallPluginsForCore', () => {
  const installed: InstalledPluginRecord[] = [
    {
      pluginId: 'sh2-shp-survey-js',
      version: '0.2.22',
      enabled: true,
      package: 'humdek/sh2-shp-survey-js',
      repository: { type: 'vcs', url: 'https://github.com/humdek-unibe-ch/sh2-shp-survey-js.git' },
    },
  ];

  it('re-requires every plugin against the new core, repairs, snapshots and restarts', async () => {
    const { deps, calls, restarts } = fake();
    const res = await reinstallPluginsForCore({ plugins: installed, coreVersion: '0.5.0' }, deps);

    expect(res).toEqual({ reinstalled: ['sh2-shp-survey-js'], restarted: true });
    const backendCmds = calls.filter((c) => c.service === 'backend').map((c) => c.cmd);
    const requireIdx = backendCmds.findIndex((c) => c.startsWith('composer require humdek/sh2-shp-survey-js:0.2.22'));
    const repairIdx = backendCmds.findIndex((c) => c.includes('selfhelp:plugin:repair'));
    const snapshotIdx = backendCmds.findIndex((c) => c.includes('tar -cf'));
    expect(requireIdx).toBeGreaterThanOrEqual(0);
    expect(repairIdx).toBeGreaterThan(requireIdx);
    expect(snapshotIdx).toBeGreaterThan(repairIdx);
    // Snapshot is keyed by the NEW core version (the old one must not be reused).
    expect(backendCmds[snapshotIdx]).toContain(pluginStateSnapshotPath('0.5.0'));
    // Caches are recompiled in every service so the new-core kernel loads the
    // reinstalled plugin bundles + routes (else the admin API 404s post-update).
    for (const svc of ['backend', 'worker', 'scheduler'] as const) {
      expect(calls.some((c) => c.service === svc && c.cmd.includes('cache:clear'))).toBe(true);
    }
    expect(restarts).toEqual([['backend', 'worker', 'scheduler']]);
  });

  it('is a no-op when the instance has no composer-backed plugins', async () => {
    const { deps, calls, restarts } = fake();
    const res = await reinstallPluginsForCore({ plugins: [], coreVersion: '0.5.0' }, deps);
    expect(res).toEqual({ reinstalled: [], restarted: false });
    expect(calls).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it('falls back to the promoted archive path repo for plugins without an upstream repository', async () => {
    // Standalone-archive installs record no composer repository in their
    // manifest; their verified backend package was promoted to the plugin
    // volume at install time and must be reused after a core update.
    const archivePlugin: InstalledPluginRecord[] = [
      { pluginId: 'qa-archive-plugin', version: '1.2.0', enabled: true, package: 'humdek/qa-archive-plugin', repository: null },
    ];
    const { deps, calls } = fake({ archiveDirPresent: true });
    const res = await reinstallPluginsForCore({ plugins: archivePlugin, coreVersion: '0.5.0' }, deps);

    expect(res.reinstalled).toEqual(['qa-archive-plugin']);
    const repoConfig = calls.find((c) => c.cmd.startsWith('composer config repositories.shm-qa-archive-plugin'));
    expect(repoConfig?.cmd).toContain('"type":"path"');
    expect(repoConfig?.cmd).toContain('/app/var/plugins/qa-archive-plugin-1.2.0/installed/backend/package');
    expect(calls.some((c) => c.cmd.startsWith('composer require humdek/qa-archive-plugin:1.2.0'))).toBe(true);
  });

  it('attempts a plain composer require when neither a repository nor a promoted archive exists', async () => {
    const orphan: InstalledPluginRecord[] = [
      { pluginId: 'qa-orphan-plugin', version: '2.0.0', enabled: true, package: 'humdek/qa-orphan-plugin', repository: null },
    ];
    const { deps, calls } = fake({ archiveDirPresent: false });
    await reinstallPluginsForCore({ plugins: orphan, coreVersion: '0.5.0' }, deps);

    // No repo registered — composer resolves from its default channels (and a
    // failure surfaces through the update flow's normal rollback).
    expect(calls.some((c) => c.cmd.startsWith('composer config repositories.shm-qa-orphan-plugin'))).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith('composer require humdek/qa-orphan-plugin:2.0.0'))).toBe(true);
  });
});

describe('restorePluginStateIfNeeded', () => {
  it('does nothing while the marker file is intact', async () => {
    const { deps, restarts } = fake({ markerPresent: true });
    const res = await restorePluginStateIfNeeded(deps, '0.4.2');
    expect(res).toEqual({ restored: false });
    expect(restarts).toEqual([]);
  });

  it('does nothing when no snapshot exists (instance never had plugins)', async () => {
    const { deps, restarts } = fake({ markerPresent: false, snapshotPresent: false });
    const res = await restorePluginStateIfNeeded(deps, '0.4.2');
    expect(res).toEqual({ restored: false });
    expect(restarts).toEqual([]);
  });

  it('extracts the snapshot into all Symfony services and restarts them after a recreate', async () => {
    const { deps, calls, restarts } = fake({ markerPresent: false, snapshotPresent: true });
    const res = await restorePluginStateIfNeeded(deps, '0.4.2');
    expect(res).toEqual({ restored: true });
    for (const svc of ['backend', 'worker', 'scheduler'] as const) {
      const extract = calls.find((c) => c.service === svc && c.cmd.includes('tar -xf'));
      expect(extract?.cmd).toContain(pluginStateSnapshotPath('0.4.2'));
      // After restoring the snapshot the recreated container has lazily warmed a
      // plugin-less cache; recompile it before restart so the restored plugins
      // (and their routes) are active again.
      const extractIdx = calls.findIndex((c) => c.service === svc && c.cmd.includes('tar -xf'));
      const clearIdx = calls.findIndex((c) => c.service === svc && c.cmd.includes('cache:clear'));
      expect(clearIdx).toBeGreaterThan(extractIdx);
    }
    expect(restarts).toEqual([['backend', 'worker', 'scheduler']]);
  });
});
