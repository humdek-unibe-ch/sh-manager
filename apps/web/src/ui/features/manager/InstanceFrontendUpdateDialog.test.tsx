// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Frontend-only update dialog: dry-run reveals the resolved frontend target,
 * and execution is gated behind the dry-run (the operator must see the plan
 * first). All against the in-memory fake ApiClient.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { InstanceFrontendUpdateDialog } from './InstanceFrontendUpdateDialog';
import { makeFakeClient } from '../../test/fake-client';

function renderDialog(client = makeFakeClient(), onStarted = vi.fn()) {
  render(
    <InstanceFrontendUpdateDialog
      client={client}
      instanceId="clinic-a"
      opened
      onClose={() => {}}
      onStarted={onStarted}
    />,
  );
  return { client, onStarted };
}

describe('InstanceFrontendUpdateDialog', () => {
  it('keeps execution disabled until a dry-run reveals a target frontend', async () => {
    const user = userEvent.setup();
    const { client } = renderDialog();
    const execSpy = vi.spyOn(client, 'executeFrontendUpdate');

    // Before any dry-run, the execute button is disabled.
    expect(screen.getByRole('button', { name: /Update frontend/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Run dry-run/i }));

    // The resolved plan shows the current -> target frontend versions.
    expect(await screen.findByText('0.1.5')).toBeInTheDocument();
    expect(screen.getByText('0.1.7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update frontend/i })).toBeEnabled();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('executes the frontend-only update after the dry-run', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const execSpy = vi.spyOn(client, 'executeFrontendUpdate');
    const onStarted = vi.fn();
    renderDialog(client, onStarted);

    await user.click(screen.getByRole('button', { name: /Run dry-run/i }));
    await screen.findByText('0.1.7');
    await user.click(screen.getByRole('button', { name: /Update frontend/i }));

    await waitFor(() => expect(execSpy).toHaveBeenCalledWith('clinic-a', {}));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });

  it('does not execute when the dry-run reports the frontend is up to date', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({
      frontendDryRunPlan: {
        instanceId: 'clinic-a',
        kind: 'frontend',
        currentFrontendVersion: '0.1.7',
        targetFrontendVersion: null,
        status: 'up_to_date',
        frontend: null,
        reasons: ['Frontend 0.1.7 is up to date.'],
        steps: [],
      },
    });
    const execSpy = vi.spyOn(client, 'executeFrontendUpdate');
    renderDialog(client);

    await user.click(screen.getByRole('button', { name: /Run dry-run/i }));
    expect(await screen.findByText('up_to_date')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update frontend/i })).toBeDisabled();
    expect(execSpy).not.toHaveBeenCalled();
  });
});
