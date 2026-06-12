// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from 'vitest';
import { WIZARD_STEPS } from '../../wizard';
import {
  activePhaseIndex,
  CHECK_META,
  CREATE_INSTANCE_STEPS,
  createStepIndexForPhase,
  INSTALL_STEPS,
  phaseIndexForStep,
  WIZARD_PHASES,
} from './wizard-view';

describe('wizard phase mapping', () => {
  it('maps every server step to exactly one phase', () => {
    for (const step of WIZARD_STEPS) {
      const phases = WIZARD_PHASES.filter((p) => p.steps.includes(step));
      expect(phases, `step ${step}`).toHaveLength(1);
    }
  });

  it('orders phases welcome → … → done', () => {
    expect(WIZARD_PHASES[0]?.id).toBe('welcome');
    expect(WIZARD_PHASES[WIZARD_PHASES.length - 1]?.id).toBe('done');
    expect(phaseIndexForStep('docker')).toBe(WIZARD_PHASES.findIndex((p) => p.id === 'preflight'));
  });

  it('highlights the install phase while installing and done when finished', () => {
    const installIdx = WIZARD_PHASES.findIndex((p) => p.id === 'install');
    expect(activePhaseIndex('install', true, false)).toBe(installIdx);
    expect(activePhaseIndex('install', false, true)).toBe(WIZARD_PHASES.length - 1);
    expect(activePhaseIndex('done', false, false)).toBe(WIZARD_PHASES.length - 1);
  });
});

describe('check + install metadata', () => {
  it('has copy for each preflight check', () => {
    for (const c of ['docker', 'internet', 'registry', 'resources']) {
      expect(CHECK_META[c]?.title).toBeTruthy();
      expect(CHECK_META[c]?.fix).toBeTruthy();
    }
  });

  it('lists the documented install steps', () => {
    expect(INSTALL_STEPS.length).toBeGreaterThanOrEqual(13);
    expect(INSTALL_STEPS[0]?.label).toMatch(/folder/i);
    expect(INSTALL_STEPS.some((s) => /migration/i.test(s.label))).toBe(true);
  });
});

describe('create-instance phase checklist', () => {
  it('maps every journaled install stage onto its checklist row, in order', () => {
    // The exact stages instanceInstall reports via onStep (journaled as the
    // operation phase); the checklist must track them monotonically.
    const journalPhases = ['registry', 'compose', 'start', 'wait_db', 'migrations', 'admin', 'plugins', 'cache_warm', 'health'];
    const indices = journalPhases.map((p) => createStepIndexForPhase(p));
    expect(indices).toEqual(journalPhases.map((p) => CREATE_INSTANCE_STEPS.findIndex((s) => s.id === p)));
    for (let i = 1; i < indices.length; i++) expect(indices[i]!).toBeGreaterThan(indices[i - 1]!);
  });

  it('parks prelude/unknown phases on the first row and "seed" on migrations', () => {
    expect(createStepIndexForPhase(undefined)).toBe(0);
    expect(createStepIndexForPhase('starting')).toBe(0);
    expect(createStepIndexForPhase('install')).toBe(0);
    expect(createStepIndexForPhase('something-new')).toBe(0);
    expect(createStepIndexForPhase('seed')).toBe(CREATE_INSTANCE_STEPS.findIndex((s) => s.id === 'migrations'));
  });
});
