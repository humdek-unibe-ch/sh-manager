// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from 'vitest';
import { buildOperationSteps } from './operation-steps';
import type { OperationKind, OperationStatus } from './types';

function states(kind: OperationKind, phase: string, status: OperationStatus): Record<string, string> {
  return Object.fromEntries(buildOperationSteps({ kind, phase, status }).map((s) => [s.id, s.state]));
}

describe('buildOperationSteps', () => {
  it('shows the active phase running and later rows waiting (single-phase running op)', () => {
    const map = states('instance_update', 'plan', 'running');
    expect(map.plan).toBe('running');
    expect(map.backup).toBe('waiting');
    expect(map.health).toBe('waiting');
  });

  it('ticks every row green when the operation succeeds', () => {
    const map = states('instance_update', 'plan', 'succeeded');
    for (const state of Object.values(map)) expect(state).toBe('success');
  });

  it('marks the active row failed and leaves later rows waiting on failure', () => {
    const map = states('instance_update', 'plan', 'failed');
    expect(map.plan).toBe('failed');
    expect(map.backup).toBe('waiting');
  });

  it('advances multi-phase restore row-by-row as the phase changes', () => {
    const atPre = states('instance_restore', 'pre-restore backup', 'running');
    expect(atPre['pre-restore backup']).toBe('running');
    expect(atPre.restore).toBe('waiting');

    const atRestore = states('instance_restore', 'restore', 'running');
    expect(atRestore['pre-restore backup']).toBe('success');
    expect(atRestore.restore).toBe('running');
  });

  it('fails only the active restore step, keeping the earlier one green', () => {
    const map = states('instance_restore', 'restore', 'failed');
    expect(map['pre-restore backup']).toBe('success');
    expect(map.restore).toBe('failed');
  });

  it('matches a dynamic remove phase by prefix', () => {
    const map = states('instance_remove', 'remove (delete)', 'running');
    expect(map.remove).toBe('running');
  });

  it('delegates instance_create to the install checklist (active phase = migrations)', () => {
    const steps = buildOperationSteps({ kind: 'instance_create', phase: 'migrations', status: 'running' });
    const byId = Object.fromEntries(steps.map((s) => [s.id, s.state]));
    expect(byId.registry).toBe('success');
    expect(byId.migrations).toBe('running');
    expect(byId.health).toBe('waiting');
  });

  it('falls back to the first row for an unknown/prelude phase', () => {
    const map = states('cms_operations_drain', 'starting', 'running');
    expect(map.drain).toBe('running');
  });
});
