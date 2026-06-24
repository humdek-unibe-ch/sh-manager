// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Unit tests for the mobile-preview branch of {@link buildOperationExecutor}.
 *
 * The CMS-driven operation loop dispatches by `op.kind`. These tests pin the
 * NEW `mobile-preview` branch in isolation (the heavy `instanceMobilePreviewUpdate`
 * action is mocked — it is covered end to end by `smoke.test.ts`): the executor
 * must (1) honor an explicit `targetMobilePreviewVersion` and otherwise fall back
 * to `targetVersion` ('latest'), (2) map a successful lightweight report onto the
 * shared `UpdateExecutionReport` (target = the preview version), and (3) surface a
 * non-executed plan (blocked resolver OR blocking plugin↔preview gate) as a FAILED
 * report carrying the reasons — so the loop writes an actionable status back rather
 * than silently doing nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActionDeps } from './shared.js';
import type { ApprovedUpdate, PendingOperation, PhaseReporter } from '@shm/core';

vi.mock('./update.js', () => ({
  instanceUpdate: vi.fn(),
  instanceFrontendUpdate: vi.fn(),
  instanceMobilePreviewUpdate: vi.fn(),
}));

import { instanceMobilePreviewUpdate } from './update.js';
import { buildOperationExecutor } from './operations.js';

const mockMpUpdate = vi.mocked(instanceMobilePreviewUpdate);

const deps = {} as ActionDeps;
const approved = { instanceId: 'inst-a' } as ApprovedUpdate;

function mpOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    operationId: 'op_mp',
    instanceId: 'inst-a',
    kind: 'mobile-preview',
    targetVersion: 'latest',
    ...overrides,
  } as PendingOperation;
}

/** A phase reporter that records the coarse lifecycle phases the executor emits. */
function recordingPhase(): { phase: PhaseReporter; phases: string[] } {
  const phases: string[] = [];
  const phase: PhaseReporter = async (status) => {
    phases.push(status);
  };
  return { phase, phases };
}

describe('buildOperationExecutor — mobile-preview branch', () => {
  it('honors an explicit target version and maps the report onto UpdateExecutionReport', async () => {
    mockMpUpdate.mockResolvedValue({
      plan: { status: 'ok', reasons: [] },
      pluginGate: null,
      executed: true,
      report: {
        instanceId: 'inst-a',
        targetMobilePreviewVersion: '0.2.3',
        ok: true,
        rolledBack: false,
        steps: [{ name: 'pull', status: 'done', detail: '0.2.3' }],
      },
    } as any);

    const exec = buildOperationExecutor(deps);
    const { phase, phases } = recordingPhase();
    const report = await exec(approved, mpOp({ targetMobilePreviewVersion: '0.2.3' }), phase);

    // The explicit preview version wins over the generic targetVersion.
    expect(mockMpUpdate).toHaveBeenCalledWith(deps, 'inst-a', { target: '0.2.3' });
    expect(report).toMatchObject({ instanceId: 'inst-a', targetVersion: '0.2.3', ok: true, rolledBack: false });
    expect(report.steps).toHaveLength(1);
    // It streams progress so the loop can mirror it back to the CMS.
    expect(phases).toContain('preflight_running');
    expect(phases).toContain('health_check_running');
  });

  it("falls back to targetVersion ('latest') when no explicit preview version is set", async () => {
    mockMpUpdate.mockResolvedValue({
      plan: { status: 'ok', reasons: [] },
      pluginGate: null,
      executed: true,
      report: {
        instanceId: 'inst-a',
        targetMobilePreviewVersion: '0.1.0',
        ok: true,
        rolledBack: false,
        steps: [],
      },
    } as any);

    const exec = buildOperationExecutor(deps);
    const { phase } = recordingPhase();
    await exec(approved, mpOp(), phase);

    expect(mockMpUpdate).toHaveBeenCalledWith(deps, 'inst-a', { target: 'latest' });
  });

  it('surfaces a non-executed plan as a FAILED report carrying resolver + plugin-gate reasons', async () => {
    mockMpUpdate.mockResolvedValue({
      plan: { status: 'blocked', reasons: ['no compatible preview is published yet'] },
      pluginGate: { status: 'blocked', blocked: [{ message: 'plugin acme needs renderer >=0.3' }] },
      executed: false,
    } as any);

    const exec = buildOperationExecutor(deps);
    const { phase } = recordingPhase();
    const report = await exec(approved, mpOp({ targetMobilePreviewVersion: '0.9.9' }), phase);

    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(false);
    expect(report.targetVersion).toBe('0.9.9');
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]?.status).toBe('failed');
    expect(report.steps[0]?.detail).toContain('no compatible preview is published yet');
    expect(report.steps[0]?.detail).toContain('plugin acme needs renderer >=0.3');
  });
});
