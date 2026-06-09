// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * In-memory ApiClient for UI tests, backed by the REAL server wizard state
 * machine (`src/wizard.ts`). This means component/flow tests exercise the same
 * gating + validation the production BFF uses — no hand-rolled snapshots.
 */
import {
  advance,
  back,
  canAdvance,
  currentStep,
  initWizard,
  recordCheck,
  setConfig,
  type WizardConfig,
  type WizardState,
  type WizardStepId,
} from '../../wizard';
import type { ApiClient } from '../lib/api-client';
import type { Snapshot } from '../lib/types';

export const FULL_CONFIG: WizardConfig = {
  root: '/opt/selfhelp',
  serverId: 'research-vm-1',
  mode: 'production',
  domain: 'clinic-a.example',
  letsencryptEmail: 'ops@example.com',
  registryUrl: 'https://registry.example.com/',
  channel: 'stable',
  version: 'latest',
  instanceId: 'clinic-a',
  instanceName: 'Clinic A',
  adminEmail: 'admin@example.com',
  adminName: 'Admin',
};

const CHECK_STEPS = new Set<WizardStepId>(['docker', 'internet', 'registry', 'resources', 'install', 'health']);

function driveTo(target: WizardStepId, config: WizardConfig): WizardState {
  let state = initWizard(config);
  const ok = { ok: true, severity: 'ok' as const };
  let guard = 0;
  while (currentStep(state) !== target) {
    if (guard++ > 50) throw new Error(`could not drive wizard to ${target}`);
    const step = currentStep(state);
    if (CHECK_STEPS.has(step)) state = recordCheck(state, step, ok);
    const decision = canAdvance(state);
    if (!decision.ok) throw new Error(`stuck at ${step}: ${decision.reason ?? ''}`);
    state = advance(state);
  }
  return state;
}

export interface FakeClientOptions {
  config?: Partial<WizardConfig>;
  startAt?: WizardStepId;
  failInstall?: boolean;
}

export function makeFakeClient(opts: FakeClientOptions = {}): ApiClient {
  const config: WizardConfig = { ...FULL_CONFIG, ...opts.config };
  let state = opts.startAt ? driveTo(opts.startAt, config) : initWizard(config);

  const snapshot = (extra?: Partial<Snapshot>): Snapshot => ({
    mode: 'bootstrap',
    step: currentStep(state),
    stepIndex: state.stepIndex,
    steps: [...state.steps],
    config: state.config,
    checks: state.checks,
    completed: state.completed,
    canAdvance: canAdvance(state),
    ...extra,
  });

  return {
    async getState() {
      return snapshot();
    },
    async setConfig(patch) {
      state = setConfig(state, patch);
      return snapshot();
    },
    async advance() {
      state = advance(state);
      return snapshot();
    },
    async back() {
      state = back(state);
      return snapshot();
    },
    async runCheck(step) {
      state = recordCheck(state, step, { ok: true, severity: 'ok', detail: `${step} check passed.` });
      return snapshot();
    },
    async install() {
      if (opts.failInstall) {
        return snapshot({ outcome: { ok: false, detail: 'Install failed while pulling images: token=supersecret123' } });
      }
      state = recordCheck(state, 'install', { ok: true, severity: 'ok', detail: 'Installed.' });
      state = recordCheck(state, 'health', { ok: true, severity: 'ok', detail: 'Healthy.' });
      return snapshot({
        outcome: { ok: true, instanceDir: '/opt/selfhelp/instances/clinic-a', version: '0.1.0', publicUrl: 'https://clinic-a.example' },
        health: { healthy: true, degraded: false },
        publicUrl: 'https://clinic-a.example',
      });
    },
    async login() {
      return { ok: true, email: 'owner@example.com', roles: ['server_owner'], csrfToken: 'csrf-token' };
    },
    async logout() {
      // no-op
    },
  };
}
