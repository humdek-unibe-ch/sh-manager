// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { OperationsConsole } from './OperationsConsole';
import { makeFakeClient } from '../../test/fake-client';

describe('OperationsConsole', () => {
  it('shows the admin shell with sidebar instances, environment status and only real CLI commands', async () => {
    render(<OperationsConsole client={makeFakeClient()} />);

    expect(await screen.findByText('Server operations')).toBeInTheDocument();
    expect(screen.getByText('Environment status')).toBeInTheDocument();
    // The instances inventory is a first-class GUI feature: sidebar + table.
    expect(await screen.findByRole('button', { name: 'Instance clinic-a' })).toBeInTheDocument();
    expect((await screen.findAllByText('Instances')).length).toBeGreaterThan(0);
    // The old, non-existent command spellings must never come back.
    expect(screen.queryByText(/sh-manager backup create/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sh-manager support bundle/i)).not.toBeInTheDocument();
    // CLI-only diagnostics use the real command names.
    expect(screen.getByText(/sh-manager instance support-bundle/i)).toBeInTheDocument();
  });

  it('runs the environment checks automatically on load — nothing stays "Pending"', async () => {
    render(<OperationsConsole client={makeFakeClient()} />);

    await screen.findByText('Server operations');
    // All four checks complete without any operator click (one preflight call).
    await waitFor(() => expect(screen.getAllByText('OK.')).toHaveLength(4));
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
  });

  it('re-runs the checks on demand', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const spy = vi.spyOn(client, 'runPreflight');
    render(<OperationsConsole client={client} />);

    await screen.findByText('Server operations');
    await waitFor(() => expect(screen.getAllByText('OK.')).toHaveLength(4));
    spy.mockClear();

    await user.click(screen.getByRole('button', { name: /run all checks/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it('opens the full-page create wizard automatically when the server has no instances yet', async () => {
    render(<OperationsConsole client={makeFakeClient({ instances: [], serverInitialized: false })} />);

    // Straight into the guided setup (welcome step), not an empty dashboard.
    expect(await screen.findByText('Set up SelfHelp on this server')).toBeInTheDocument();
    expect((await screen.findAllByText(/first instance/i)).length).toBeGreaterThan(0);
  });

  it('shows the installed manager version and "up to date" when no newer release exists', async () => {
    render(<OperationsConsole client={makeFakeClient()} />);

    expect(await screen.findByText('Manager version')).toBeInTheDocument();
    expect(await screen.findByText(/sh-manager 0\.1\.4/)).toBeInTheDocument();
    // Shown twice by design: the metric card hint + the version card badge.
    expect((await screen.findAllByText('Up to date')).length).toBeGreaterThan(0);
  });

  it('surfaces an available manager update with the exact docker pull command', async () => {
    render(<OperationsConsole client={makeFakeClient({ managerUpdateAvailable: true })} />);

    expect((await screen.findAllByText(/Update available: 0\.2\.0/)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/docker pull ghcr\.io\/humdek-unibe-ch\/sh-manager:v0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Release notes for 0\.2\.0/i })).toHaveAttribute(
      'href',
      'https://github.com/humdek-unibe-ch/sh-manager/releases/tag/v0.2.0',
    );
  });

  it('signs out through the header button', async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(<OperationsConsole client={makeFakeClient()} onSignOut={onSignOut} />);

    await screen.findByText('Server operations');
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
