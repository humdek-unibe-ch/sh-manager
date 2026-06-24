// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from 'vitest';
import { buildOperationSteps, operationKindLabel } from './operation-steps';
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
    // The restore now reports its inner stages live: pre-restore backup ->
    // verify -> stop -> volumes -> database -> config -> recreate -> migrate ->
    // health (regression for "restore showed all steps at once at the end").
    const atPre = states('instance_restore', 'pre-restore backup', 'running');
    expect(atPre['pre-restore backup']).toBe('running');
    expect(atPre.database).toBe('waiting');
    expect(atPre.health).toBe('waiting');

    const atDatabase = states('instance_restore', 'database', 'running');
    expect(atDatabase['pre-restore backup']).toBe('success');
    expect(atDatabase.verify).toBe('success');
    expect(atDatabase.stop).toBe('success');
    expect(atDatabase.volumes).toBe('success');
    expect(atDatabase.database).toBe('running');
    expect(atDatabase.health).toBe('waiting');
  });

  it('fails only the active restore step, keeping the earlier ones green', () => {
    const map = states('instance_restore', 'database', 'failed');
    expect(map['pre-restore backup']).toBe('success');
    expect(map.verify).toBe('success');
    expect(map.database).toBe('failed');
    expect(map.health).toBe('waiting');
  });

  it('advances the multi-phase clone row-by-row as the live phase changes', () => {
    // Regression for "clone showed one step": the clone now reports plan ->
    // secrets -> volumes -> database -> recreate -> health live.
    const atSecrets = states('instance_clone', 'secrets', 'running');
    expect(atSecrets.plan).toBe('success');
    expect(atSecrets.secrets).toBe('running');
    expect(atSecrets.database).toBe('waiting');

    const atDatabase = states('instance_clone', 'database', 'running');
    expect(atDatabase.secrets).toBe('success');
    expect(atDatabase.volumes).toBe('success');
    expect(atDatabase.database).toBe('running');
    expect(atDatabase.health).toBe('waiting');
  });

  it('advances the multi-phase backup row-by-row (database -> metadata -> volumes -> manifest)', () => {
    const atVolumes = states('instance_backup', 'volumes', 'running');
    expect(atVolumes.database).toBe('success');
    expect(atVolumes.metadata).toBe('success');
    expect(atVolumes.volumes).toBe('running');
    expect(atVolumes.manifest).toBe('waiting');
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

  it('renders the single-row disable/enable lifecycle steps', () => {
    expect(states('instance_disable', 'disable', 'running').disable).toBe('running');
    expect(states('instance_disable', 'disable', 'succeeded').disable).toBe('success');
    expect(states('instance_enable', 'enable', 'running').enable).toBe('running');
    expect(states('instance_enable', 'enable', 'succeeded').enable).toBe('success');
  });
});

describe('operationKindLabel', () => {
  it('gives the CMS-drain kind a human label instead of operator jargon', () => {
    expect(operationKindLabel('cms_operations_drain')).toBe('Plugin / CMS operation');
  });

  it('spells out the core update so it is not confused with a plugin/CMS op', () => {
    // Regression: a CMS-requested core update was journaled as the generic drain
    // and shown as "Plugin / CMS operation"; it must read as a core update now.
    expect(operationKindLabel('instance_update')).toBe('instance core update');
  });

  it('humanises other kinds by replacing underscores', () => {
    expect(operationKindLabel('instance_backup')).toBe('instance backup');
    expect(operationKindLabel('instance_frontend_update')).toBe('instance frontend update');
    expect(operationKindLabel('instance_disable')).toBe('instance disable');
    expect(operationKindLabel('instance_enable')).toBe('instance enable');
  });
});

describe('CMS-drained update phase ids drive real checklist rows', () => {
  // Contract with cmsUpdatePhaseStep() in instances.ts: each step id it emits
  // for a drained CMS update MUST be a real row, or the live operation history
  // would fall back to row 0 and never advance.
  it('instance_update has rows for every core-update phase id', () => {
    const ids = buildOperationSteps({ kind: 'instance_update', phase: 'plan', status: 'running' }).map((s) => s.id);
    for (const id of ['plan', 'backup', 'pull', 'migrations', 'health']) expect(ids).toContain(id);
  });

  it('instance_frontend_update has rows for every frontend-update phase id', () => {
    const ids = buildOperationSteps({ kind: 'instance_frontend_update', phase: 'plan', status: 'running' }).map(
      (s) => s.id,
    );
    for (const id of ['plan', 'pull', 'health']) expect(ids).toContain(id);
  });

  it('instance_mobile_preview_update has rows for every preview-update phase id', () => {
    const ids = buildOperationSteps({ kind: 'instance_mobile_preview_update', phase: 'plan', status: 'running' }).map(
      (s) => s.id,
    );
    for (const id of ['plan', 'pull', 'health']) expect(ids).toContain(id);
  });
});
