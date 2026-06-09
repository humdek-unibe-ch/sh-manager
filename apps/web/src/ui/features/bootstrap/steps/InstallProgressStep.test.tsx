// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../../../test/render';
import { InstallProgressStep } from './InstallProgressStep';

describe('InstallProgressStep', () => {
  it('renders the documented install steps while running', () => {
    render(<InstallProgressStep phase="running" />);
    expect(screen.getByText(/Installing SelfHelp/i)).toBeInTheDocument();
    expect(screen.getByText('Create instance folder')).toBeInTheDocument();
    expect(screen.getByText('Run database migrations')).toBeInTheDocument();
    expect(screen.getByText(/Secrets are generated safely/i)).toBeInTheDocument();
  });

  it('shows a failed step with retry and redacts secrets from the error', () => {
    const onRetry = vi.fn();
    render(<InstallProgressStep phase="failed" error="compose up failed: db password=hunter2" onRetry={onRetry} />);

    expect(screen.getByText('Installation stopped')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry installation/i })).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('hunter2');
    expect(document.body.textContent ?? '').toContain('password=••••••');
  });
});
