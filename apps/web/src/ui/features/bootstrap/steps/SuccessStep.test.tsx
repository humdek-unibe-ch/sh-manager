// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '../../../test/render';
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
  outcome: { ok: true, instanceDir: '/opt/selfhelp/instances/clinic-a', version: '0.1.0', publicUrl: 'https://clinic-a.example' },
  health: { healthy: true, degraded: false },
  publicUrl: 'https://clinic-a.example',
};

const RESULT_WITH_PASSWORD: InstallResult = {
  ...RESULT,
  outcome: {
    ...RESULT.outcome,
    adminPassword: 'gen-pw-shown-once-12345',
    adminPasswordFile: '/opt/selfhelp/instances/clinic-a/secrets/admin_password',
  },
};

describe('SuccessStep', () => {
  it('celebrates the install and links to the public URL', () => {
    render(<SuccessStep result={RESULT} config={FULL_CONFIG} snapshot={SNAPSHOT} />);

    expect(screen.getByText(/Clinic A is ready/i)).toBeInTheDocument();
    expect(screen.getByText(/SelfHelp 0\.1\.0 is installed/i)).toBeInTheDocument();
    expect(screen.getByText(/All services healthy/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open selfhelp/i })).toHaveAttribute('href', 'https://clinic-a.example');
    expect(screen.getByText('/opt/selfhelp/instances/clinic-a/manifest.json')).toBeInTheDocument();
  });

  it('shows the generated admin password masked, revealed only on demand, with its server-side file path', () => {
    render(<SuccessStep result={RESULT_WITH_PASSWORD} config={FULL_CONFIG} snapshot={SNAPSHOT} />);

    expect(screen.getByText(/Administrator sign-in \(shown once\)/i)).toBeInTheDocument();
    // Masked until the operator explicitly reveals it.
    expect(document.body.textContent ?? '').not.toContain('gen-pw-shown-once-12345');
    fireEvent.click(screen.getByRole('button', { name: /reveal generated admin password/i }));
    expect(screen.getByText('gen-pw-shown-once-12345')).toBeInTheDocument();
    // Copy works without revealing; the server-side retrieval file is named.
    expect(screen.getByRole('button', { name: /copy generated admin password/i })).toBeInTheDocument();
    expect(screen.getByText('/opt/selfhelp/instances/clinic-a/secrets/admin_password')).toBeInTheDocument();
  });

  it('points at the server-side password file (and prints no secret) when the one-shot value is gone', () => {
    // E.g. the page was reloaded after install: the password no longer rides
    // on any response, so the operator is sent to the restricted file instead.
    render(<SuccessStep result={RESULT} config={FULL_CONFIG} snapshot={SNAPSHOT} />);

    expect(screen.getByText(/Retrieve your admin password from the server/i)).toBeInTheDocument();
    expect(screen.getByText(/secrets\/admin_password/)).toBeInTheDocument();
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
