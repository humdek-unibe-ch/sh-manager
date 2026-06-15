// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Per-instance log viewer: reads a service's recent (server-redacted) container
 * logs on demand and lets the operator switch the service. All against the
 * in-memory fake ApiClient — never a real BFF or Docker.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { LogsDialog } from './LogsDialog';
import { makeFakeClient } from '../../test/fake-client';

describe('LogsDialog', () => {
  it('shows the default service (backend) logs when opened', async () => {
    const client = makeFakeClient({
      logs: { 'clinic-a:backend': 'backend-1  | [OK] backend ready\n' },
    });
    render(<LogsDialog client={client} instanceId="clinic-a" opened onClose={() => {}} />);

    expect(await screen.findByText(/backend ready/)).toBeInTheDocument();
  });

  it('refetches the logs when the operator switches the service', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({
      logs: {
        'clinic-a:backend': 'backend-1  | backend line\n',
        'clinic-a:frontend': 'frontend-1  | frontend line\n',
      },
    });
    const spy = vi.spyOn(client, 'getInstanceLogs');
    render(<LogsDialog client={client} instanceId="clinic-a" opened onClose={() => {}} />);

    expect(await screen.findByText(/backend line/)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Service', { selector: 'input' }));
    await user.click(await screen.findByRole('option', { name: /Frontend/i }));

    expect(await screen.findByText(/frontend line/)).toBeInTheDocument();
    await waitFor(() => expect(spy).toHaveBeenCalledWith('clinic-a', 'frontend', expect.any(Number)));
  });

  it('shows a friendly empty state when a service has no output', async () => {
    const client = makeFakeClient({ logs: { 'clinic-a:backend': '' } });
    render(<LogsDialog client={client} instanceId="clinic-a" opened onClose={() => {}} />);

    expect(await screen.findByText(/No log output/i)).toBeInTheDocument();
  });
});
