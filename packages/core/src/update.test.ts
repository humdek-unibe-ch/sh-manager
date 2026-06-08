// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { CoreRelease, FrontendRelease, PluginRelease } from '@shm/schemas';
import { RecordingComposeRunner } from '@shm/docker';
import { executeUpdate, planUpdate, type UpdatePlan } from './update.js';
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

  it('runs backup -> pull -> up -> migrate -> health in order', async () => {
    const runner = new RecordingComposeRunner();
    const order: string[] = [];
    const report = await executeUpdate(approved, okPlan(), {
      runner, instanceDir: '/tmp/website1',
      takeBackup: async () => { order.push('backup'); return { backupId: 'backup-1' }; },
      applyArtifacts: async () => { order.push('apply'); },
      runMigrations: async () => { order.push('migrate'); },
      checkHealth: async () => { order.push('health'); return healthy; },
      rollback: async () => { order.push('rollback'); },
    });
    expect(report.ok).toBe(true);
    expect(report.rolledBack).toBe(false);
    expect(order).toEqual(['backup', 'apply', 'migrate', 'health']);
    expect(runner.calls.map((c) => c.args[0])).toEqual(['pull', 'up']);
  });

  it('rolls back when health fails after the update', async () => {
    const runner = new RecordingComposeRunner();
    let rolledBackTo = '';
    const report = await executeUpdate(approved, okPlan(), {
      runner, instanceDir: '/tmp/website1',
      takeBackup: async () => ({ backupId: 'backup-1' }),
      applyArtifacts: async () => undefined,
      runMigrations: async () => undefined,
      checkHealth: async () => unhealthy,
      rollback: async ({ backupId }) => { rolledBackTo = backupId; },
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);
    expect(rolledBackTo).toBe('backup-1');
  });

  it('refuses to execute a blocked plan', async () => {
    const blocked: UpdatePlan = { ...okPlan(), status: 'blocked' };
    await expect(
      executeUpdate(approved, blocked, {
        runner: new RecordingComposeRunner(), instanceDir: '/tmp/x',
        takeBackup: async () => ({ backupId: 'b' }), applyArtifacts: async () => undefined,
        runMigrations: async () => undefined, checkHealth: async () => healthy, rollback: async () => undefined,
      }),
    ).rejects.toThrow(/blocked/i);
  });
});
