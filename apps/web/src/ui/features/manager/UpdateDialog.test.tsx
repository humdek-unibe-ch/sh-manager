// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * The single combined update window. It must:
 *   - default to the core mode and explain that the core update brings a
 *     matching frontend in the same operation (the resolved frontend version is
 *     shown in the dry-run plan, so there is no "new core / old frontend" trap);
 *   - let the operator switch to a frontend-only swap that keeps the core;
 *   - feed each mode from the correct registry feed (core vs frontend).
 * All against the in-memory fake ApiClient.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { UpdateDialog } from './UpdateDialog';
import { makeFakeClient } from '../../test/fake-client';

function renderDialog(client = makeFakeClient(), onStarted = vi.fn(), extra: { mobilePreviewAvailable?: boolean } = {}) {
  render(
    <UpdateDialog
      client={client}
      instanceId="clinic-a"
      opened
      onClose={() => {}}
      onStarted={onStarted}
      {...extra}
    />,
  );
  return { client, onStarted };
}

describe('UpdateDialog (combined core + frontend)', () => {
  it('defaults to core mode and shows the matching frontend that ships with the core update', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const spy = vi.spyOn(client, 'listVersions');
    renderDialog(client);

    // The mode explanation makes the "they move together" contract explicit.
    expect(screen.getByText('Core and frontend move together')).toBeInTheDocument();
    // Core mode reads the core feed (never the frontend feed yet).
    await waitFor(() => expect(spy).toHaveBeenCalledWith(undefined, 'core'));
    expect(spy).not.toHaveBeenCalledWith(undefined, 'frontend');

    await user.click(screen.getByRole('button', { name: /Run dry-run/i }));

    // The plan reveals the resolved frontend that travels with the new core.
    expect(await screen.findByText(/compatible frontend/i)).toBeInTheDocument();
    expect(screen.getAllByText('0.2.0').length).toBeGreaterThan(0);
  });

  it('switches to a frontend-only swap and reads the frontend feed', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const spy = vi.spyOn(client, 'listVersions');
    renderDialog(client);

    await user.click(screen.getByText('Frontend only (keep core)'));

    expect(screen.getByText('Frontend-only swap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update frontend/i })).toBeInTheDocument();
    await waitFor(() => expect(spy).toHaveBeenCalledWith(undefined, 'frontend'));
  });

  it('executes a frontend-only update from the combined window after a dry-run', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const execSpy = vi.spyOn(client, 'executeFrontendUpdate');
    const onStarted = vi.fn();
    renderDialog(client, onStarted);

    await user.click(screen.getByText('Frontend only (keep core)'));
    await user.click(screen.getByRole('button', { name: /Run dry-run/i }));
    await screen.findAllByText('0.1.7');
    await user.click(screen.getByRole('button', { name: /Update frontend/i }));

    await waitFor(() => expect(execSpy).toHaveBeenCalledWith('clinic-a', {}));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });

  // The mobile preview ships separately, but the manager bootstraps a missing
  // one (`up -d --no-deps mobile-preview` creates the container), so the mode is
  // ALWAYS offered — labelled "install" until the instance has it.
  it('offers a mobile-preview INSTALL tab when the preview is not installed', async () => {
    const user = userEvent.setup();
    renderDialog(makeFakeClient(), vi.fn(), { mobilePreviewAvailable: false });

    await user.click(screen.getByText('Mobile preview (install)'));

    expect(screen.getByText('Install the mobile preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install mobile preview/i })).toBeInTheDocument();
  });

  it('offers a mobile-preview UPDATE tab when the preview is installed', async () => {
    const user = userEvent.setup();
    renderDialog(makeFakeClient(), vi.fn(), { mobilePreviewAvailable: true });

    await user.click(screen.getByText('Mobile preview only'));

    expect(screen.getByText('Mobile-preview-only swap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update mobile preview/i })).toBeInTheDocument();
  });
});
