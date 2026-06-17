// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Operations console instance flows: the full-page create-instance wizard + live install log, with validation parity against the server.
 *
 * Split out of the original `InstanceManagement.test.tsx`; renders through the
 * shared Mantine-aware `../../test/render` and the in-memory
 * `../../test/fake-client`. The test bodies are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { OperationsConsole } from './OperationsConsole';
import { makeFakeClient } from '../../test/fake-client';

describe('OperationsConsole instance flows', () => {
  it('navigates between the dashboard and an instance through the sidebar', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    // Instances are listed in the left sidebar with their domain.
    const instanceLink = await screen.findByRole('button', { name: 'Instance clinic-a' });
    expect(instanceLink).toHaveTextContent('clinic-a.example');

    await user.click(instanceLink);
    expect(await screen.findByText('Operation history')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(await screen.findByText('Server operations')).toBeInTheDocument();
  });

  /** Drive the full-page wizard past Welcome + Preflight (auto-run, all green). */
  async function passWelcomeAndPreflight(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    // Welcome step.
    expect(await screen.findByText(/checks the environment/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // Preflight runs automatically; all four checks come back green.
    expect(await screen.findByText('Docker engine & Compose')).toBeInTheDocument();
    const cont = screen.getByRole('button', { name: /continue/i });
    await waitFor(() => expect(cont).toBeEnabled());
    await user.click(cont);
  }

  it('creates an instance through the full-page wizard and watches the live install log', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    await screen.findByText('Server operations');
    await user.click(screen.getAllByRole('button', { name: /new instance/i })[0]!);

    expect(await screen.findByText('Create a new instance')).toBeInTheDocument();
    await passWelcomeAndPreflight(user);

    // Basics. The admin password is explicitly NOT shown in the browser; the
    // operator reads the restricted server-side file. The optional mailer DSN
    // lives here too.
    expect(await screen.findByText(/never shown in the browser/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/outbound email/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/display name/i), 'Website One');
    const idInput = screen.getByLabelText(/instance id/i);
    expect(idInput).toHaveValue('website-one'); // auto-suggested from the name
    await user.clear(idInput);
    await user.type(idInput, 'website1');
    await user.type(screen.getByLabelText(/admin email/i), 'admin@example.org');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Address (production is preselected, needs a domain).
    await user.type(await screen.findByLabelText(/^domain/i), 'site.example.org');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Release: version comes from the registry dropdown ("latest" default).
    const versionInput = await screen.findByLabelText(/selfhelp version/i, { selector: 'input' });
    expect(versionInput).toHaveValue('latest — newest verified release');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Review shows the collected plan, then installs.
    expect(await screen.findByText('site.example.org', { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /install instance/i }));

    // The install screen shows the guided phase checklist (driven by the
    // journaled operation phase) plus the raw log. The fake's operation
    // completes instantly, so every row is already ticked.
    expect(await screen.findByText('Resolve & verify release')).toBeInTheDocument();
    expect(screen.getByText('Run database migrations')).toBeInTheDocument();
    expect(screen.getByText('Run health checks')).toBeInTheDocument();

    // The journaled install log streams inside the wizard.
    expect(await screen.findByText(/instance_create finished/)).toBeInTheDocument();
    expect(await screen.findByText(/is installed/i)).toBeInTheDocument();

    // Open the new instance straight from the wizard.
    await user.click(screen.getByRole('button', { name: /open instance/i }));
    expect(await screen.findByText('Operation history')).toBeInTheDocument();
    // The sidebar now lists the new instance too.
    expect(screen.getByRole('button', { name: 'Instance website1' })).toBeInTheDocument();
  });

  it('warns about leftover data for a previously-removed id and clears it on request', async () => {
    const user = userEvent.setup();
    render(
      <OperationsConsole
        client={makeFakeClient({ orphans: { 'ghost-1': ['selfhelp_ghost-1_mysql_data'] } })}
      />,
    );

    await screen.findByText('Server operations');
    await user.click(screen.getAllByRole('button', { name: /new instance/i })[0]!);
    await screen.findByText('Create a new instance');
    await passWelcomeAndPreflight(user);

    // Basics: choose the id of a previously-removed-but-not-fully-deleted instance.
    const idInput = await screen.findByLabelText(/instance id/i);
    await user.clear(idInput);
    await user.type(idInput, 'ghost-1');

    // The orphan scan (debounced) surfaces the leftover volume.
    expect(await screen.findByText(/leftover data found/i)).toBeInTheDocument();
    expect(screen.getByText(/selfhelp_ghost-1_mysql_data/)).toBeInTheDocument();

    // "Remove leftover data" cleans it, and the warning disappears.
    await user.click(screen.getByRole('button', { name: /remove leftover data/i }));
    await waitFor(() => expect(screen.queryByText(/leftover data found/i)).not.toBeInTheDocument());
  });

  it('rejects invalid wizard input with the SAME validation the server runs', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    await screen.findByText('Server operations');
    await user.click(screen.getAllByRole('button', { name: /new instance/i })[0]!);
    await passWelcomeAndPreflight(user);

    await screen.findByText(/never shown in the browser/i);
    await user.type(screen.getByLabelText(/display name/i), 'Bad Instance');
    const idInput = screen.getByLabelText(/instance id/i);
    await user.clear(idInput);
    await user.type(idInput, '-bad-id');
    expect(await screen.findByText(/lowercase letters, digits and dashes/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/admin email/i), 'not-an-email');
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();

    // A malformed mailer DSN locks the step too (same shared rule as the BFF).
    await user.type(screen.getByLabelText(/outbound email/i), 'mail.example.org');
    expect(await screen.findByText(/smtp:\/\/user:pass@mail\.example\.org/i)).toBeInTheDocument();

    // Continue stays locked while the basics are invalid.
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });
});
