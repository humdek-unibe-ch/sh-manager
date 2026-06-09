// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, userEvent } from '../../test/render';
import { BootstrapWizard } from './BootstrapWizard';
import { makeFakeClient } from '../../test/fake-client';

describe('BootstrapWizard flow', () => {
  it('shows the welcome screen and advances into preflight', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizard client={makeFakeClient()} />);

    expect(await screen.findByText(/Set up SelfHelp on this server/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /start setup/i }));

    expect(await screen.findByText(/Check this server is ready/i)).toBeInTheDocument();
    expect(screen.getByText('Docker engine & Compose')).toBeInTheDocument();
  });

  it('runs a preflight check and then offers Continue', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizard client={makeFakeClient({ startAt: 'docker' })} />);

    const runBtn = await screen.findByRole('button', { name: /Run Docker engine & Compose check/i });
    await user.click(runBtn);

    const continueBtn = await screen.findByRole('button', { name: /^continue$/i });
    expect(continueBtn).toBeEnabled();
    expect(screen.getByText('Passed')).toBeInTheDocument();
  });

  it('reviews, requires explicit confirmation, installs and shows success', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizard client={makeFakeClient({ startAt: 'install' })} />);

    expect(await screen.findByText(/Review before installing/i)).toBeInTheDocument();
    const installBtn = screen.getByRole('button', { name: /install selfhelp/i });
    expect(installBtn).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(installBtn).toBeEnabled();
    await user.click(installBtn);

    expect(await screen.findByText(/Clinic A is ready/i)).toBeInTheDocument();
    expect(screen.getByText('https://clinic-a.example')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open selfhelp/i })).toHaveAttribute('href', 'https://clinic-a.example');
    expect(screen.getByText(/All services healthy/i)).toBeInTheDocument();
  });

  it('shows a failed install with a retry and never leaks a secret', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizard client={makeFakeClient({ startAt: 'install', failInstall: true })} />);

    await screen.findByText(/Review before installing/i);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /install selfhelp/i }));

    expect(await screen.findByText(/Installation stopped/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry installation/i })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('supersecret123');
    expect(document.body.textContent).toContain('token=••••••');
  });

  it('renders production vs local address fields and the DNS warning', async () => {
    const prod = render(<BootstrapWizard client={makeFakeClient({ startAt: 'domain' })} />);
    expect(await screen.findByLabelText(/public domain/i)).toBeInTheDocument();
    expect(screen.getByText(/DNS is validated before install/i)).toBeInTheDocument();
    prod.unmount();

    render(<BootstrapWizard client={makeFakeClient({ startAt: 'domain', config: { mode: 'local', domain: undefined, localPort: 8080 } })} />);
    expect(await screen.findByLabelText(/localhost port/i)).toBeInTheDocument();
    expect(screen.queryByText(/DNS is validated before install/i)).toBeNull();
  });

  it('keeps Continue disabled until a required field becomes valid', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizard client={makeFakeClient({ startAt: 'mode', config: { serverId: '' } })} />);

    const continueBtn = await screen.findByRole('button', { name: /^continue$/i });
    expect(continueBtn).toBeDisabled();

    await user.type(screen.getByLabelText(/server id/i), 'research-vm-1');
    expect(continueBtn).toBeEnabled();
  });
});
