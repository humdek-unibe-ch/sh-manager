// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from 'vitest';
import {
  advance,
  back,
  buildBootstrapPlan,
  canAdvance,
  currentStep,
  initWizard,
  isBootstrapComplete,
  recordCheck,
  validateConfig,
  validateStep,
  WizardError,
  WIZARD_STEPS,
  type WizardConfig,
  type WizardState,
} from './wizard.js';

function productionConfig(): WizardConfig {
  return {
    root: '/opt/selfhelp',
    serverId: 'srv-1',
    mode: 'production',
    domain: 'app.example.com',
    letsencryptEmail: 'ops@example.com',
    registryUrl: 'https://registry.example.com/',
    channel: 'stable',
    version: 'latest',
    instanceId: 'clinic-a',
    instanceName: 'Clinic A',
    adminEmail: 'admin@example.com',
    adminName: 'Admin',
  };
}

/** Drive the wizard to a given step, satisfying check gates along the way. */
function atStep(target: string, config: WizardConfig): WizardState {
  let s = initWizard(config);
  const okCheck = { ok: true, severity: 'ok' as const };
  while (currentStep(s) !== target) {
    const step = currentStep(s);
    if (['docker', 'internet', 'registry', 'resources', 'install', 'health'].includes(step)) {
      s = recordCheck(s, step, okCheck);
    }
    const decision = canAdvance(s);
    if (!decision.ok) throw new Error(`stuck at ${step}: ${decision.reason}`);
    s = advance(s);
  }
  return s;
}

describe('wizard state machine', () => {
  it('starts at welcome with sane defaults', () => {
    const s = initWizard();
    expect(currentStep(s)).toBe('welcome');
    expect(s.config.mode).toBe('production');
    expect(s.config.registryUrl).toMatch(/^https:\/\//);
    expect(s.completed).toBe(false);
  });

  it('covers every declared step in order', () => {
    expect(WIZARD_STEPS[0]).toBe('welcome');
    expect(WIZARD_STEPS[WIZARD_STEPS.length - 1]).toBe('done');
    expect(WIZARD_STEPS).toContain('proxy');
    expect(WIZARD_STEPS).toContain('admin');
    expect(WIZARD_STEPS).toContain('health');
  });

  it('blocks a check step until a passing result is recorded', () => {
    let s = atStep('docker', productionConfig());
    expect(canAdvance(s).ok).toBe(false); // no check yet
    s = recordCheck(s, 'docker', { ok: false, severity: 'error', detail: 'no engine' });
    expect(canAdvance(s).ok).toBe(false); // failed check still blocks
    expect(canAdvance(s).reason).toContain('no engine');
    s = recordCheck(s, 'docker', { ok: true, severity: 'ok' });
    expect(canAdvance(s).ok).toBe(true);
  });

  it('allows advancing past a warning check', () => {
    let s = atStep('resources', productionConfig());
    s = recordCheck(s, 'resources', { ok: true, severity: 'warning', detail: 'low memory' });
    expect(canAdvance(s).ok).toBe(true);
  });

  it('validates production domain and local port per mode', () => {
    const prod = productionConfig();
    expect(validateStep('domain', prod)).toEqual([]);
    expect(validateStep('domain', { ...prod, domain: 'not a domain' }).length).toBeGreaterThan(0);

    const local: WizardConfig = { ...prod, mode: 'local', domain: undefined, localPort: 3000 };
    expect(validateStep('domain', local)).toEqual([]);
    expect(validateStep('domain', { ...local, localPort: 70000 }).length).toBeGreaterThan(0);
    expect(validateStep('domain', { ...local, localPort: undefined }).length).toBeGreaterThan(0);
  });

  it('enforces the instance id format and registry scheme', () => {
    const c = productionConfig();
    expect(validateStep('instance', c)).toEqual([]);
    expect(validateStep('instance', { ...c, instanceId: 'BadId' }).length).toBeGreaterThan(0);
    expect(validateStep('instance', { ...c, registryUrl: 'ftp://x' }).length).toBeGreaterThan(0);
  });

  it('treats admin as optional but validates a supplied email', () => {
    const c = productionConfig();
    expect(validateStep('admin', { ...c, adminEmail: undefined })).toEqual([]);
    expect(validateStep('admin', { ...c, adminEmail: 'bogus' }).length).toBeGreaterThan(0);
  });

  it('can step back', () => {
    const s = atStep('mode', productionConfig());
    expect(currentStep(back(s))).toBe('resources');
  });

  it('marks completed when it reaches done', () => {
    const s = atStep('done', productionConfig());
    expect(currentStep(s)).toBe('done');
    expect(isBootstrapComplete(s)).toBe(true);
  });
});

describe('buildBootstrapPlan', () => {
  it('produces a production plan that pins domain + provision + bringUp', () => {
    const plan = buildBootstrapPlan(productionConfig());
    expect(plan.serverInit).toEqual({ serverId: 'srv-1', mode: 'production', letsencryptEmail: 'ops@example.com' });
    expect(plan.instanceInstall.mode).toBe('production');
    expect(plan.instanceInstall.domain).toBe('app.example.com');
    expect(plan.instanceInstall.localPort).toBeUndefined();
    expect(plan.instanceInstall.bringUp).toBe(true);
    expect(plan.instanceInstall.provision).toBe(true);
    expect(plan.instanceInstall.adminEmail).toBe('admin@example.com');
  });

  it('produces a local plan with a port and no domain/letsencrypt', () => {
    const local: WizardConfig = { ...productionConfig(), mode: 'local', domain: undefined, localPort: 8081, letsencryptEmail: undefined };
    const plan = buildBootstrapPlan(local);
    expect(plan.serverInit.letsencryptEmail).toBeUndefined();
    expect(plan.instanceInstall.localPort).toBe(8081);
    expect(plan.instanceInstall.domain).toBeUndefined();
  });

  it('never carries a secret/password field anywhere in the plan', () => {
    const plan = buildBootstrapPlan(productionConfig());
    const serialized = JSON.stringify(plan).toLowerCase();
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret');
  });

  it('throws on an invalid config', () => {
    const bad: WizardConfig = { ...productionConfig(), instanceId: '' };
    expect(() => buildBootstrapPlan(bad)).toThrow(WizardError);
  });

  it('validateConfig surfaces every blocking problem', () => {
    const blank = initWizard().config;
    const errors = validateConfig(blank);
    expect(errors.length).toBeGreaterThan(0);
  });
});
