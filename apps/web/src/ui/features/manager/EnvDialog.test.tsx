// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Environment editor dialog: renders the effective non-secret env, keeps
 * manager-owned keys read-only (revealed on demand), persists only the
 * operator's edits + custom variables, and refuses a key the server would
 * reject — all against the in-memory fake ApiClient.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { EnvDialog } from './EnvDialog';
import { makeFakeClient } from '../../test/fake-client';

function renderDialog(client = makeFakeClient(), onStarted = vi.fn()) {
  render(
    <EnvDialog client={client} instanceId="clinic-a" opened onClose={() => {}} onStarted={onStarted} />,
  );
  return { client, onStarted };
}

describe('EnvDialog', () => {
  it('shows editable values and keeps managed keys hidden until requested', async () => {
    const user = userEvent.setup();
    renderDialog();

    // An editable default is shown with its value.
    expect(await screen.findByText('JWT_TOKEN_TTL')).toBeInTheDocument();
    expect(screen.getByDisplayValue('3600')).toBeInTheDocument();

    // Manager-owned keys are not rendered until the operator reveals them.
    expect(screen.queryByText('SYMFONY_INTERNAL_URL')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show managed variables/i }));
    expect(await screen.findByText('SYMFONY_INTERNAL_URL')).toBeInTheDocument();
  });

  it('persists ONLY the edited default plus a new custom variable', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const spy = vi.spyOn(client, 'setInstanceEnv');
    const onStarted = vi.fn();
    renderDialog(client, onStarted);

    const ttl = await screen.findByDisplayValue('3600');
    await user.clear(ttl);
    await user.type(ttl, '7200');

    await user.click(screen.getByRole('button', { name: /Add variable/i }));
    await user.type(screen.getByLabelText('Name'), 'MY_FLAG');
    await user.type(screen.getByLabelText('Value'), 'on');

    await user.click(screen.getByRole('button', { name: /Apply & restart/i }));

    // FRONTEND_BASE_URL / APP_DEBUG were untouched, so they are NOT sent.
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('clinic-a', { overrides: { JWT_TOKEN_TTL: '7200', MY_FLAG: 'on' } }),
    );
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });

  it('blocks saving a custom key that collides with a manager-owned key', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const spy = vi.spyOn(client, 'setInstanceEnv');
    renderDialog(client);

    await screen.findByText('JWT_TOKEN_TTL');
    await user.click(screen.getByRole('button', { name: /Add variable/i }));
    await user.type(screen.getByLabelText('Name'), 'SELFHELP_INSTANCE_ID');
    await user.type(screen.getByLabelText('Value'), 'evil');

    expect(await screen.findByText(/managed by the manager/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply & restart/i })).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
  });
});
