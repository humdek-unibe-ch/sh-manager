// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { CoreRelease, FrontendRelease, PluginRelease } from '@shm/schemas';
import { RecordingComposeRunner } from '@shm/docker';
import {
  evaluateMysqlMajorUpgrade,
  executeFrontendUpdate,
  executeUpdate,
  imageMajor,
  planFrontendUpdate,
  planUpdate,
  resolveTargetRuntimeImages,
  type FrontendUpdatePlan,
  type UpdatePlan,
} from './update.js';
import type { RuntimeServicePolicy } from '@shm/schemas';
import type { PreflightResourceFacts } from './preflight.js';
import type { ApprovedUpdate } from './instance-scope.js';
import type { HealthReport } from './health.js';

const GiB = 1024 * 1024 * 1024;
const resources: PreflightResourceFacts = {
  requiredPortsFree: [{ port: 443, free: true }],
  diskBytesFree: 50 * GiB,
  memoryBytesTotal: 8 * GiB,
  cpuCount: 4,
  dockerAvailable: true,
  dockerComposeAvailable: true,
};

function mkCore(version: string, opts: Partial<CoreRelease> = {}): CoreRelease {
  return {
    kind: 'selfhelp-core-release',
    id: `selfhelp-core-${version}`,
    version,
    channel: 'stable',
    releasedAt: '2026-06-01T00:00:00Z',
    minimumDirectUpgradeFrom: '1.0.0',
    pluginApiVersion: '2.1',
    backend: { image: `ghcr.io/selfhelp/backend:${version}`, digest: 'sha256:b' },
    worker: { image: `ghcr.io/selfhelp/worker:${version}`, digest: 'sha256:w' },
    scheduler: { image: `ghcr.io/selfhelp/scheduler:${version}`, digest: 'sha256:s' },
    frontendCompatibility: { requiredFrontendRange: `>=${version} <1.6.0` },
    database: { migrationRange: 'V1..V2', destructive: false, requiresBackup: true, manualConfirmationRequired: false },
    security: { signature: 'sig', keyId: 'official-2026', signedPayloadSha256: 'sha256:p' },
    ...opts,
  };
}

function mkFrontend(version: string, requiredCoreRange: string): FrontendRelease {
  return {
    kind: 'selfhelp-frontend-release',
    id: `selfhelp-frontend-${version}`,
    version,
    channel: 'stable',
    image: `ghcr.io/selfhelp/frontend:${version}`,
    digest: 'sha256:f',
    backendCompatibility: { requiredCoreRange, requiredApiVersion: '2.1' },
    security: { signature: 'sig', keyId: 'official-2026' },
  };
}

function mkPlugin(id: string, version: string, coreRange: string): PluginRelease {
  return {
    kind: 'selfhelp-plugin-release',
    id,
    version,
    channel: 'stable',
    official: true,
    compatibility: { core: coreRange, pluginApi: '>=2.0' },
    artifacts: { manifestUrl: 'https://r/m.json', archiveUrl: 'https://r/a.shplugin', sha256: 'sha256:a' },
    security: { signature: 'sig', keyId: 'official-2026' },
  };
}

describe('planUpdate', () => {
  it('reports up_to_date when already on the newest release', () => {
    const plan = planUpdate({
      instanceId: 'website1', currentVersion: '1.5.0', coreReleases: [mkCore('1.5.0')],
      frontendReleases: [mkFrontend('1.5.0', '>=1.5.0 <1.6.0')], pluginReleases: [], installedPlugins: [], resources,
    });
    expect(plan.status).toBe('up_to_date');
  });

  it('produces an ok plan with a compatible frontend and steps', () => {
    const plan = planUpdate({
      instanceId: 'website1', currentVersion: '1.4.0',
      coreReleases: [mkCore('1.5.0')], frontendReleases: [mkFrontend('1.5.0', '>=1.5.0 <1.6.0')],
      pluginReleases: [], installedPlugins: [], resources,
    });
    expect(plan.status).toBe('ok');
    expect(plan.targetVersion).toBe('1.5.0');
    expect(plan.frontend?.version).toBe('1.5.0');
    expect(plan.preflight?.status).toBe('ok');
    expect(plan.steps.length).toBeGreaterThan(3);
  });

  it('blocks when an installed plugin is incompatible with the target core', () => {
    const plan = planUpdate({
      instanceId: 'website1', currentVersion: '1.4.0',
      coreReleases: [mkCore('1.5.0')], frontendReleases: [mkFrontend('1.5.0', '>=1.5.0 <1.6.0')],
      pluginReleases: [mkPlugin('survey-js', '1.3.0', '>=1.0.0 <1.5.0')],
      installedPlugins: [{ id: 'survey-js', version: '1.3.0' }], resources,
    });
    expect(plan.status).toBe('blocked');
    expect(plan.pluginEvaluations[0]?.blocked).toBe(true);
    expect(plan.preflight?.checks.some((c) => c.code === 'compatibility')).toBe(true);
  });

  it('warns for a destructive migration', () => {
    const plan = planUpdate({
      instanceId: 'website1', currentVersion: '1.4.0',
      coreReleases: [mkCore('1.5.0', { database: { migrationRange: 'V1..V3', destructive: true, requiresBackup: true, manualConfirmationRequired: true } })],
      frontendReleases: [mkFrontend('1.5.0', '>=1.5.0 <1.6.0')], pluginReleases: [], installedPlugins: [], resources,
    });
    expect(plan.status).toBe('warning');
  });
});

describe('executeUpdate', () => {
  const okPlan = (): UpdatePlan =>
    planUpdate({
      instanceId: 'website1', currentVersion: '1.4.0',
      coreReleases: [mkCore('1.5.0')], frontendReleases: [mkFrontend('1.5.0', '>=1.5.0 <1.6.0')],
      pluginReleases: [], installedPlugins: [], resources,
    });
  const approved: ApprovedUpdate = {
    instanceId: 'website1', targetVersion: '1.5.0', preflightId: 'pf', approvedByUserId: 1,
    audit: { at: 'now', actorUserId: 1, requestedInstanceId: 'website1', trustedInstanceId: 'website1', allowed: true, reason: 'ok' },
  };
  const healthy: HealthReport = { instanceId: 'website1', overall: 'healthy', services: [], checkedAt: 'now' };
  const unhealthy: HealthReport = { instanceId: 'website1', overall: 'unhealthy', services: [], checkedAt: 'now' };

  it('runs backup -> snapshot -> pull -> up -> migrate -> health in order', async () => {
    const runner = new RecordingComposeRunner();
    const order: string[] = [];
    const report = await executeUpdate(approved, okPlan(), {
      runner, instanceDir: '/tmp/website1',
      takeBackup: async () => { order.push('backup'); return { backupId: 'backup-1' }; },
      snapshot: async () => { order.push('snapshot'); },
      applyArtifacts: async () => { order.push('apply'); },
      runMigrations: async () => { order.push('migrate'); },
      checkHealth: async () => { order.push('health'); return healthy; },
      rollback: async () => { order.push('rollback'); },
    });
    expect(report.ok).toBe(true);
    expect(report.rolledBack).toBe(false);
    expect(order).toEqual(['backup', 'snapshot', 'apply', 'migrate', 'health']);
    expect(runner.calls.map((c) => c.args[0])).toEqual(['pull', 'up']);
  });

  it('streams each step live through onStep, in order, matching the final report', async () => {
    // Regression for the "I only saw the first step, then everything finished at
    // once" report: the manager journal advances per step via this hook, so it
    // must fire as each step happens (not only in the final report).
    const seen: string[] = [];
    const report = await executeUpdate(approved, okPlan(), {
      runner: new RecordingComposeRunner(), instanceDir: '/tmp/website1',
      takeBackup: async () => ({ backupId: 'backup-1' }),
      snapshot: async () => undefined,
      applyArtifacts: async () => undefined,
      runMigrations: async () => undefined,
      restorePlugins: async () => undefined,
      checkHealth: async () => healthy,
      rollback: async () => undefined,
      onStep: (step) => { seen.push(step.name); },
    });
    expect(report.ok).toBe(true);
    // The hook saw the milestones live, and the live sequence equals the report.
    expect(seen).toEqual(['backup', 'snapshot', 'pull', 'apply-artifacts', 'up', 'migrate', 'plugins', 'health']);
    expect(seen).toEqual(report.steps.map((s) => s.name));
  });

  it('never lets a throwing onStep hook break the update', async () => {
    const report = await executeUpdate(approved, okPlan(), {
      runner: new RecordingComposeRunner(), instanceDir: '/tmp/website1',
      takeBackup: async () => ({ backupId: 'backup-1' }),
      snapshot: async () => undefined,
      applyArtifacts: async () => undefined,
      runMigrations: async () => undefined,
      checkHealth: async () => healthy,
      rollback: async () => undefined,
      onStep: () => { throw new Error('journal write failed'); },
    });
    expect(report.ok).toBe(true);
  });

  it('reinstalls plugins after migrations and before the health gate, rolling back when it fails', async () => {
    // The recreated containers carry only the baked vendor state, so plugin
    // restore is part of the gated update path: health must validate the
    // restored plugins, and a restore failure must roll back like any other.
    const okOrder: string[] = [];
    const okReport = await executeUpdate(approved, okPlan(), {
      runner: new RecordingComposeRunner(), instanceDir: '/tmp/website1',
      takeBackup: async () => { okOrder.push('backup'); return { backupId: 'backup-1' }; },
      snapshot: async () => { okOrder.push('snapshot'); },
      applyArtifacts: async () => { okOrder.push('apply'); },
      runMigrations: async () => { okOrder.push('migrate'); },
      restorePlugins: async () => { okOrder.push('plugins'); },
      checkHealth: async () => { okOrder.push('health'); return healthy; },
      rollback: async () => { okOrder.push('rollback'); },
    });
    expect(okReport.ok).toBe(true);
    expect(okOrder).toEqual(['backup', 'snapshot', 'apply', 'migrate', 'plugins', 'health']);
    expect(okReport.steps.map((s) => s.name)).toContain('plugins');

    let rolledBack = false;
    const failReport = await executeUpdate(approved, okPlan(), {
      runner: new RecordingComposeRunner(), instanceDir: '/tmp/website1',
      takeBackup: async () => ({ backupId: 'backup-1' }),
      snapshot: async () => undefined,
      applyArtifacts: async () => undefined,
      runMigrations: async () => undefined,
      restorePlugins: async () => { throw new Error('composer rate limited'); },
      checkHealth: async () => healthy,
      rollback: async () => { rolledBack = true; },
    });
    expect(failReport.ok).toBe(false);
    expect(failReport.rolledBack).toBe(true);
    expect(rolledBack).toBe(true);
  });

  it('snapshots before mutating and aborts (no pull) when the snapshot fails', async () => {
    const runner = new RecordingComposeRunner();
    let applied = false;
    const report = await executeUpdate(approved, okPlan(), {
      runner, instanceDir: '/tmp/website1',
      takeBackup: async () => ({ backupId: 'backup-1' }),
      snapshot: async () => { throw new Error('snap failed'); },
      applyArtifacts: async () => { applied = true; },
      runMigrations: async () => undefined,
      checkHealth: async () => healthy,
      rollback: async () => undefined,
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(false);
    expect(applied).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it('rolls back the snapshot on a pre-migration failure and does not require manual restore', async () => {
    const runner = new RecordingComposeRunner();
    const order: string[] = [];
    let rollbackCtx: { backupId: string; migrated: boolean; destructive: boolean } | null = null;
    const report = await executeUpdate(approved, okPlan(), {
      runner, instanceDir: '/tmp/website1',
      takeBackup: async () => { order.push('backup'); return { backupId: 'backup-1' }; },
      snapshot: async () => { order.push('snapshot'); },
      applyArtifacts: async () => { order.push('apply'); throw new Error('apply boom'); },
      runMigrations: async () => { order.push('migrate'); },
      checkHealth: async () => healthy,
      rollback: async (ctx) => { rollbackCtx = ctx; order.push('rollback'); },
    });
    expect(order).toEqual(['backup', 'snapshot', 'apply', 'rollback']);
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);
    expect(report.requiresManualRestore).toBeUndefined();
    expect(rollbackCtx).toMatchObject({ backupId: 'backup-1', migrated: false });
  });

  it('rolls back when health fails after the update', async () => {
    const runner = new RecordingComposeRunner();
    let rolledBackTo = '';
    const report = await executeUpdate(approved, okPlan(), {
      runner, instanceDir: '/tmp/website1',
      takeBackup: async () => ({ backupId: 'backup-1' }),
      snapshot: async () => undefined,
      applyArtifacts: async () => undefined,
      runMigrations: async () => undefined,
      checkHealth: async () => unhealthy,
      rollback: async ({ backupId }) => { rolledBackTo = backupId; },
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);
    expect(rolledBackTo).toBe('backup-1');
  });

  it('flags a manual restore when a destructive migration fails', async () => {
    const destructivePlan = planUpdate({
      instanceId: 'website1', currentVersion: '1.4.0',
      coreReleases: [mkCore('1.5.0', { database: { migrationRange: 'V1..V3', destructive: true, requiresBackup: true, manualConfirmationRequired: true } })],
      frontendReleases: [mkFrontend('1.5.0', '>=1.5.0 <1.6.0')], pluginReleases: [], installedPlugins: [], resources,
    });
    let rollbackCtx: { migrated: boolean; destructive: boolean } | null = null;
    const report = await executeUpdate(approved, destructivePlan, {
      runner: new RecordingComposeRunner(), instanceDir: '/tmp/website1',
      takeBackup: async () => ({ backupId: 'backup-1' }),
      snapshot: async () => undefined,
      applyArtifacts: async () => undefined,
      runMigrations: async () => { throw new Error('migration boom'); },
      checkHealth: async () => healthy,
      rollback: async (ctx) => { rollbackCtx = ctx; },
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);
    expect(report.requiresManualRestore).toBe(true);
    expect(rollbackCtx).toMatchObject({ migrated: true, destructive: true });
  });

  it('enters maintenance + stops traffic producers before mutating, re-asserts after up, and exits only after health', async () => {
    const runner = new RecordingComposeRunner();
    const order: string[] = [];
    let stopped: readonly string[] = [];
    const report = await executeUpdate(approved, okPlan(), {
      runner, instanceDir: '/tmp/website1',
      takeBackup: async () => { order.push('backup'); return { backupId: 'backup-1' }; },
      snapshot: async () => { order.push('snapshot'); },
      enterMaintenance: async () => { order.push('enter'); },
      stopServices: async (names) => { stopped = names; order.push(`stop:${names.join(',')}`); },
      applyArtifacts: async () => { order.push('apply'); },
      runMigrations: async () => { order.push('migrate'); },
      checkHealth: async () => { order.push('health'); return healthy; },
      exitMaintenance: async () => { order.push('exit'); },
      rollback: async () => { order.push('rollback'); },
    });
    expect(report.ok).toBe(true);
    expect(stopped).toEqual(['frontend', 'worker', 'scheduler']);
    // enter (old backend) -> stop -> apply -> enter (new backend) -> migrate -> health -> exit
    expect(order).toEqual([
      'backup', 'snapshot', 'enter', 'stop:frontend,worker,scheduler', 'apply', 'enter', 'migrate', 'health', 'exit',
    ]);
    expect(order.indexOf('exit')).toBeGreaterThan(order.indexOf('health'));
  });

  it('clears maintenance even when the update fails and rolls back', async () => {
    const order: string[] = [];
    const report = await executeUpdate(approved, okPlan(), {
      runner: new RecordingComposeRunner(), instanceDir: '/tmp/website1',
      takeBackup: async () => ({ backupId: 'backup-1' }),
      snapshot: async () => undefined,
      enterMaintenance: async () => { order.push('enter'); },
      stopServices: async () => { order.push('stop'); },
      applyArtifacts: async () => { throw new Error('apply boom'); },
      runMigrations: async () => undefined,
      checkHealth: async () => healthy,
      exitMaintenance: async () => { order.push('exit'); },
      rollback: async () => { order.push('rollback'); },
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);
    // maintenance is always cleared after rollback
    expect(order).toEqual(['enter', 'stop', 'rollback', 'exit']);
  });

  it('resolves runtime images from the target core, falling back to current images', () => {
    const current = { mysql: 'mysql:8.4', redis: 'redis:7.2', mercure: 'dunglas/mercure:0.18' };
    // No runtime policy -> keep current images.
    expect(resolveTargetRuntimeImages(undefined, current)).toEqual(current);
    // Policy present -> use its recommended images.
    const runtime: RuntimeServicePolicy = {
      mysql: { supportedVersions: '>=8.0.0 <10.0.0', recommendedImage: 'mysql:9.0' },
      redis: { supportedVersions: '>=7.0.0 <8.0.0', recommendedImage: 'redis:7.4' },
      mercure: { supportedVersions: '>=0.15.0 <1.0.0', recommendedImage: 'dunglas/mercure:0.18' },
    };
    expect(resolveTargetRuntimeImages(runtime, current)).toEqual({
      mysql: 'mysql:9.0', redis: 'redis:7.4', mercure: 'dunglas/mercure:0.18',
    });
  });

  it('parses the major version from an image reference', () => {
    expect(imageMajor('mysql:8.4')).toBe(8);
    expect(imageMajor('mysql:9.0.1')).toBe(9);
    expect(imageMajor('dunglas/mercure:0.18')).toBe(0);
    expect(imageMajor('mysql:8.4@sha256:abc')).toBe(8);
    expect(imageMajor('mysql')).toBeNull();
  });

  it('flags a MySQL major upgrade only when the policy requires approval', () => {
    const requireApproval: RuntimeServicePolicy = {
      mysql: { supportedVersions: '>=8.0.0 <10.0.0', recommendedImage: 'mysql:9.0', majorUpgradeRequiresManualApproval: true },
      redis: { supportedVersions: '*', recommendedImage: 'redis:7.2' },
      mercure: { supportedVersions: '*', recommendedImage: 'dunglas/mercure:0.18' },
    };
    const major = evaluateMysqlMajorUpgrade(requireApproval, 'mysql:8.4', 'mysql:9.0');
    expect(major).toMatchObject({ isMajorUpgrade: true, requiresApproval: true, fromMajor: 8, toMajor: 9 });

    // Same major -> not an upgrade, no approval.
    const minor = evaluateMysqlMajorUpgrade(requireApproval, 'mysql:8.0', 'mysql:8.4');
    expect(minor).toMatchObject({ isMajorUpgrade: false, requiresApproval: false });

    // Major jump but policy does not require approval.
    const noPolicy = evaluateMysqlMajorUpgrade(undefined, 'mysql:8.4', 'mysql:9.0');
    expect(noPolicy).toMatchObject({ isMajorUpgrade: true, requiresApproval: false });
  });

  it('refuses to execute a blocked plan', async () => {
    const blocked: UpdatePlan = { ...okPlan(), status: 'blocked' };
    await expect(
      executeUpdate(approved, blocked, {
        runner: new RecordingComposeRunner(), instanceDir: '/tmp/x',
        takeBackup: async () => ({ backupId: 'b' }), snapshot: async () => undefined, applyArtifacts: async () => undefined,
        runMigrations: async () => undefined, checkHealth: async () => healthy, rollback: async () => undefined,
      }),
    ).rejects.toThrow(/blocked/i);
  });
});

describe('planFrontendUpdate', () => {
  const frontendReleases = [
    mkFrontend('1.5.0', '>=1.4.0 <1.6.0'),
    mkFrontend('1.5.3', '>=1.4.0 <1.6.0'),
  ];

  it('selects the newest compatible frontend newer than the installed one', () => {
    const plan = planFrontendUpdate({
      instanceId: 'website1', currentFrontendVersion: '1.5.0', coreVersion: '1.4.0', frontendReleases,
    });
    expect(plan.kind).toBe('frontend');
    expect(plan.status).toBe('ok');
    expect(plan.targetFrontendVersion).toBe('1.5.3');
    expect(plan.steps.length).toBeGreaterThan(3);
  });

  it('reports up_to_date when the installed frontend is already newest', () => {
    const plan = planFrontendUpdate({
      instanceId: 'website1', currentFrontendVersion: '1.5.3', coreVersion: '1.4.0', frontendReleases,
    });
    expect(plan.status).toBe('up_to_date');
    expect(plan.frontend).toBeNull();
    expect(plan.steps).toEqual([]);
  });

  it('blocks an unavailable specific target', () => {
    const plan = planFrontendUpdate({
      instanceId: 'website1', currentFrontendVersion: '1.5.0', coreVersion: '1.4.0', frontendReleases, target: '9.9.9',
    });
    expect(plan.status).toBe('blocked');
    expect(plan.targetFrontendVersion).toBeNull();
  });

  // Regression for the frontend/core compatibility bypass: the running core's
  // requiredFrontendRange must gate a frontend-only update from the live
  // registry release OR the value recorded in the instance lock, and must never
  // be silently dropped when the core release is gone from the registry.
  describe('running-core requiredFrontendRange enforcement (the bug scenario)', () => {
    const releases = [
      mkFrontend('0.1.17', '>=0.1.0 <0.2.0'),
      mkFrontend('0.1.19', '>=0.1.0 <0.2.0'),
    ];

    it('blocks frontend 0.1.19 via the LIVE registry core range (core 0.1.11 requires <0.1.18)', () => {
      const runningCore = mkCore('0.1.11', { frontendCompatibility: { requiredFrontendRange: '>=0.1.0 <0.1.18' } });
      const plan = planFrontendUpdate({
        instanceId: 'website1',
        currentFrontendVersion: '0.1.17',
        coreVersion: '0.1.11',
        currentCore: runningCore,
        requireCoreFrontendRange: true,
        frontendReleases: releases,
        target: '0.1.19',
      });
      expect(plan.status).toBe('blocked');
      expect(plan.targetFrontendVersion).toBeNull();
      expect(plan.reasons.join(' ')).toMatch(/not accepted by the running SelfHelp core/i);
    });

    it('blocks frontend 0.1.19 via the LOCK range when the core 0.1.11 has left the registry', () => {
      const plan = planFrontendUpdate({
        instanceId: 'website1',
        currentFrontendVersion: '0.1.17',
        coreVersion: '0.1.11',
        currentCore: null,
        currentCoreRequiredFrontendRange: '>=0.1.0 <0.1.18',
        requireCoreFrontendRange: true,
        frontendReleases: releases,
        target: '0.1.19',
      });
      expect(plan.status).toBe('blocked');
      expect(plan.reasons.join(' ')).toMatch(/required frontend range/i);
    });

    it('fails closed (blocked, actionable) when neither the registry core nor the lock range is available', () => {
      const plan = planFrontendUpdate({
        instanceId: 'website1',
        currentFrontendVersion: '0.1.17',
        coreVersion: '0.1.11',
        requireCoreFrontendRange: true,
        frontendReleases: releases,
      });
      expect(plan.status).toBe('blocked');
      expect(plan.reasons.join(' ')).toMatch(/update the core first/i);
    });

    it('allows the frontend update when the lock-stored range accepts the target', () => {
      const plan = planFrontendUpdate({
        instanceId: 'website1',
        currentFrontendVersion: '0.1.16',
        coreVersion: '0.1.11',
        currentCoreRequiredFrontendRange: '>=0.1.0 <0.2.0',
        requireCoreFrontendRange: true,
        frontendReleases: releases,
        target: '0.1.19',
      });
      expect(plan.status).toBe('ok');
      expect(plan.targetFrontendVersion).toBe('0.1.19');
    });
  });
});

describe('executeFrontendUpdate', () => {
  const okPlan = (): FrontendUpdatePlan =>
    planFrontendUpdate({
      instanceId: 'website1', currentFrontendVersion: '1.5.0', coreVersion: '1.4.0',
      frontendReleases: [mkFrontend('1.5.3', '>=1.4.0 <1.6.0')],
    });
  const healthy: HealthReport = { instanceId: 'website1', overall: 'healthy', services: [], checkedAt: 'now' };
  const unhealthy: HealthReport = { instanceId: 'website1', overall: 'unhealthy', services: [], checkedAt: 'now' };

  it('runs snapshot -> apply -> pull frontend -> up -> restore plugins -> health', async () => {
    const runner = new RecordingComposeRunner();
    const order: string[] = [];
    const report = await executeFrontendUpdate(okPlan(), {
      runner, instanceDir: '/tmp/website1',
      snapshot: async () => { order.push('snapshot'); },
      applyArtifacts: async () => { order.push('apply'); },
      restorePluginState: async () => { order.push('plugins'); },
      checkHealth: async () => { order.push('health'); return healthy; },
      rollback: async () => { order.push('rollback'); },
    });
    expect(report.ok).toBe(true);
    expect(report.rolledBack).toBe(false);
    expect(report.targetFrontendVersion).toBe('1.5.3');
    // Plugins are re-mounted AFTER the recreate and BEFORE the health verdict.
    expect(order).toEqual(['snapshot', 'apply', 'plugins', 'health']);
    // Only the frontend image is pulled, but `up -d` recreates the app services
    // too so the backend re-reads SELFHELP_FRONTEND_VERSION and the CMS reports
    // the new frontend version instead of the stale one.
    expect(runner.calls.map((c) => c.args)).toEqual([
      ['pull', 'frontend'],
      ['up', '-d'],
    ]);
  });

  it('skips the plugin-restore step when no restorePluginState dep is provided', async () => {
    const runner = new RecordingComposeRunner();
    const report = await executeFrontendUpdate(okPlan(), {
      runner, instanceDir: '/tmp/website1',
      snapshot: async () => undefined,
      applyArtifacts: async () => undefined,
      checkHealth: async () => healthy,
      rollback: async () => undefined,
    });
    expect(report.ok).toBe(true);
    expect(report.steps.some((s) => s.name === 'plugins')).toBe(false);
  });

  it('aborts before any mutation when the snapshot fails', async () => {
    const runner = new RecordingComposeRunner();
    let applied = false;
    const report = await executeFrontendUpdate(okPlan(), {
      runner, instanceDir: '/tmp/website1',
      snapshot: async () => { throw new Error('snap failed'); },
      applyArtifacts: async () => { applied = true; },
      checkHealth: async () => healthy,
      rollback: async () => undefined,
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(false);
    expect(applied).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it('rolls back the config when health fails after the swap', async () => {
    let rolledBackReason = '';
    const report = await executeFrontendUpdate(okPlan(), {
      runner: new RecordingComposeRunner(), instanceDir: '/tmp/website1',
      snapshot: async () => undefined,
      applyArtifacts: async () => undefined,
      checkHealth: async () => unhealthy,
      rollback: async (reason) => { rolledBackReason = reason; },
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);
    expect(rolledBackReason).toMatch(/health/);
  });

  it('refuses to execute a non-ok plan', async () => {
    const blocked = planFrontendUpdate({
      instanceId: 'website1', currentFrontendVersion: '1.5.3', coreVersion: '1.4.0',
      frontendReleases: [mkFrontend('1.5.3', '>=1.4.0 <1.6.0')],
    });
    await expect(
      executeFrontendUpdate(blocked, {
        runner: new RecordingComposeRunner(), instanceDir: '/tmp/x',
        snapshot: async () => undefined, applyArtifacts: async () => undefined,
        checkHealth: async () => healthy, rollback: async () => undefined,
      }),
    ).rejects.toThrow(/not ok/i);
  });
});
