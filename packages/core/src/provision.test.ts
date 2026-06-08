// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from 'vitest';
import type { HealthReport } from './health.js';
import { provisionInstance, type ProvisionDeps, type ProvisionStepName } from './provision.js';

const healthy: HealthReport = {
  instanceId: 'i1',
  overall: 'healthy',
  services: [{ service: 'backend', state: 'healthy', required: true }],
  checkedAt: '2026-06-08T00:00:00.000Z',
};
const unhealthy: HealthReport = { ...healthy, overall: 'unhealthy' };
const degraded: HealthReport = { ...healthy, overall: 'degraded' };

function baseDeps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    waitForDatabase: vi.fn(async () => {}),
    runMigrations: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => healthy),
    ...over,
  };
}

const names = (steps: { name: ProvisionStepName }[]): ProvisionStepName[] => steps.map((s) => s.name);

describe('provisionInstance', () => {
  it('runs the full required sequence and reports ok when healthy', async () => {
    const report = await provisionInstance({ instanceId: 'i1', version: '8.0.0' }, baseDeps());
    expect(report.ok).toBe(true);
    expect(report.health?.overall).toBe('healthy');
    // Optional steps are recorded as skipped, in order.
    expect(names(report.steps)).toEqual(['wait_db', 'migrations', 'seed', 'admin', 'plugins', 'cache_warm', 'health']);
    expect(report.steps.find((s) => s.name === 'seed')?.status).toBe('skipped');
    expect(report.steps.find((s) => s.name === 'health')?.status).toBe('done');
  });

  it('runs optional steps when their deps are provided, in order', async () => {
    const calls: string[] = [];
    const deps = baseDeps({
      waitForDatabase: vi.fn(async () => void calls.push('wait_db')),
      runMigrations: vi.fn(async () => void calls.push('migrations')),
      seed: vi.fn(async () => void calls.push('seed')),
      createAdmin: vi.fn(async () => {
        calls.push('admin');
        return { created: true, detail: 'qa.admin@selfhelp.test' };
      }),
      installPlugins: vi.fn(async () => {
        calls.push('plugins');
        return { installed: ['surveyjs'] };
      }),
      warmCaches: vi.fn(async () => void calls.push('cache_warm')),
      checkHealth: vi.fn(async () => {
        calls.push('health');
        return healthy;
      }),
    });
    const report = await provisionInstance({ instanceId: 'i1', version: '8.0.0' }, deps);
    expect(report.ok).toBe(true);
    expect(calls).toEqual(['wait_db', 'migrations', 'seed', 'admin', 'plugins', 'cache_warm', 'health']);
    expect(report.steps.find((s) => s.name === 'admin')?.detail).toBe('qa.admin@selfhelp.test');
    expect(report.steps.find((s) => s.name === 'plugins')?.detail).toBe('surveyjs');
  });

  it('stops at a failed migration and never creates an admin or checks health', async () => {
    const createAdmin = vi.fn(async () => ({ created: true }));
    const checkHealth = vi.fn(async () => healthy);
    const report = await provisionInstance(
      { instanceId: 'i1', version: '8.0.0' },
      baseDeps({
        runMigrations: vi.fn(async () => {
          throw new Error('migration boom');
        }),
        createAdmin,
        checkHealth,
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.steps.find((s) => s.name === 'migrations')?.status).toBe('failed');
    expect(report.steps.find((s) => s.name === 'migrations')?.detail).toContain('migration boom');
    expect(names(report.steps)).toEqual(['wait_db', 'migrations']);
    expect(createAdmin).not.toHaveBeenCalled();
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('fails fast if the database never becomes ready', async () => {
    const runMigrations = vi.fn(async () => {});
    const report = await provisionInstance(
      { instanceId: 'i1', version: '8.0.0' },
      baseDeps({
        waitForDatabase: vi.fn(async () => {
          throw new Error('db timeout');
        }),
        runMigrations,
      }),
    );
    expect(report.ok).toBe(false);
    expect(names(report.steps)).toEqual(['wait_db']);
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('treats an unhealthy final check as a hard failure but keeps the report', async () => {
    const report = await provisionInstance(
      { instanceId: 'i1', version: '8.0.0' },
      baseDeps({ checkHealth: vi.fn(async () => unhealthy) }),
    );
    expect(report.ok).toBe(false);
    expect(report.health?.overall).toBe('unhealthy');
    expect(report.steps.find((s) => s.name === 'health')?.status).toBe('failed');
  });

  it('accepts a degraded final check as ok (optional service still settling)', async () => {
    const report = await provisionInstance(
      { instanceId: 'i1', version: '8.0.0' },
      baseDeps({ checkHealth: vi.fn(async () => degraded) }),
    );
    expect(report.ok).toBe(true);
    expect(report.health?.overall).toBe('degraded');
    expect(report.steps.find((s) => s.name === 'health')?.detail).toBe('overall=degraded');
  });

  it('reports admin "already exists" without failing', async () => {
    const report = await provisionInstance(
      { instanceId: 'i1', version: '8.0.0' },
      baseDeps({ createAdmin: vi.fn(async () => ({ created: false })) }),
    );
    expect(report.ok).toBe(true);
    expect(report.steps.find((s) => s.name === 'admin')?.detail).toBe('already exists');
  });

  it('emits a phase callback for every executed step', async () => {
    const phases: ProvisionStepName[] = [];
    await provisionInstance(
      { instanceId: 'i1', version: '8.0.0' },
      baseDeps({ onPhase: (n) => void phases.push(n) }),
    );
    // Skipped optional steps do not emit a phase.
    expect(phases).toEqual(['wait_db', 'migrations', 'health']);
  });
});
