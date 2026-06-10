// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, userEvent } from '../../test/render';
import { OperationsConsole } from './OperationsConsole';
import { makeFakeClient } from '../../test/fake-client';

describe('OperationsConsole', () => {
  it('shows live environment status and CLI-only instance management', async () => {
    render(<OperationsConsole client={makeFakeClient()} />);

    expect(await screen.findByText('Server operations')).toBeInTheDocument();
    expect(screen.getByText('Environment status')).toBeInTheDocument();
    expect(screen.getByText(/Instance management runs on the server/i)).toBeInTheDocument();
    expect(screen.getByText(/sh-manager backup create/i)).toBeInTheDocument();
  });

  it('runs a check and reflects the passed status', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    await screen.findByText('Server operations');
    await user.click(screen.getByRole('button', { name: /Run Docker engine & Compose check/i }));

    expect((await screen.findAllByText(/passed/i)).length).toBeGreaterThan(0);
  });

  it('shows the installed manager version and "up to date" when no newer release exists', async () => {
    render(<OperationsConsole client={makeFakeClient()} />);

    expect(await screen.findByText('Manager version')).toBeInTheDocument();
    expect(await screen.findByText(/sh-manager 0\.1\.4/)).toBeInTheDocument();
    expect(await screen.findByText('Up to date')).toBeInTheDocument();
  });

  it('surfaces an available manager update with the exact docker pull command', async () => {
    render(<OperationsConsole client={makeFakeClient({ managerUpdateAvailable: true })} />);

    expect(await screen.findByText(/Update available: 0\.2\.0/)).toBeInTheDocument();
    expect(await screen.findByText(/docker pull ghcr\.io\/humdek-unibe-ch\/sh-manager:v0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Release notes for 0\.2\.0/i })).toHaveAttribute(
      'href',
      'https://github.com/humdek-unibe-ch/sh-manager/releases/tag/v0.2.0',
    );
  });
});
