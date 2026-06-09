// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '../../../test/render';
import { SuccessStep } from './SuccessStep';
import { FULL_CONFIG } from '../../../test/fake-client';
import type { InstallResult, Snapshot } from '../../../lib/types';

const SNAPSHOT: Snapshot = {
  mode: 'bootstrap',
  step: 'done',
  stepIndex: 13,
  steps: [],
  config: FULL_CONFIG,
  checks: {},
  completed: true,
  canAdvance: { ok: false },
};

const RESULT: InstallResult = {
  outcome: { ok: true, instanceDir: '/opt/selfhelp/instances/clinic-a', version: '8.0.0', publicUrl: 'https://clinic-a.example' },
  health: { healthy: true, degraded: false },
  publicUrl: 'https://clinic-a.example',
};

describe('SuccessStep', () => {
  it('celebrates the install and links to the public URL', () => {
    render(<SuccessStep result={RESULT} config={FULL_CONFIG} snapshot={SNAPSHOT} />);

    expect(screen.getByText(/Clinic A is ready/i)).toBeInTheDocument();
    expect(screen.getByText(/SelfHelp 8\.0\.0 is installed/i)).toBeInTheDocument();
    expect(screen.getByText(/All services healthy/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open selfhelp/i })).toHaveAttribute('href', 'https://clinic-a.example');
    expect(screen.getByText('/opt/selfhelp/instances/clinic-a/manifest.json')).toBeInTheDocument();
  });

  it('tells the operator to retrieve the password from the server and never prints a secret value', () => {
    render(<SuccessStep result={RESULT} config={FULL_CONFIG} snapshot={SNAPSHOT} />);

    expect(screen.getByText(/Save your admin password now/i)).toBeInTheDocument();
    // No "password: <value>" / "token=<value>" style leak anywhere on the screen.
    expect(document.body.textContent ?? '').not.toMatch(/(password|secret|token)\s*[:=]\s*\S/i);
  });

  it('falls back to the snapshot health check when no install health is present', () => {
    const noHealth: InstallResult = { outcome: { ok: true }, publicUrl: 'https://clinic-a.example' };
    const degraded: Snapshot = { ...SNAPSHOT, checks: { health: { ok: true, severity: 'warning', detail: 'Redis slow.' } } };
    render(<SuccessStep result={noHealth} config={FULL_CONFIG} snapshot={degraded} />);
    expect(screen.getByText(/some services degraded/i)).toBeInTheDocument();
  });
});
