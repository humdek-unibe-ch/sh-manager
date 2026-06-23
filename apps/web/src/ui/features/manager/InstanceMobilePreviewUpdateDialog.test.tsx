// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Mobile-preview-only update dialog: the dry-run reveals the resolved preview
 * target AND the dual-axis plugin↔preview compatibility verdicts, execution is
 * gated behind the dry-run, and a native-renderer incompatibility blocks the
 * swap. All against the in-memory fake ApiClient.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { InstanceMobilePreviewUpdateDialog } from './InstanceMobilePreviewUpdateDialog';
import { makeFakeClient } from '../../test/fake-client';

function renderDialog(client = makeFakeClient(), onStarted = vi.fn()) {
  render(
    <InstanceMobilePreviewUpdateDialog
      client={client}
      instanceId="clinic-a"
      opened
      onClose={() => {}}
      onStarted={onStarted}
    />,
  );
  return { client, onStarted };
}

describe('InstanceMobilePreviewUpdateDialog', () => {
  it('keeps execution disabled until a dry-run reveals a target preview', async () => {
    const user = userEvent.setup();
    const { client } = renderDialog();
    const execSpy = vi.spyOn(client, 'executeMobilePreviewUpdate');

    expect(screen.getByRole('button', { name: /Update mobile preview/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Run dry-run/i }));

    // The resolved plan shows the current -> target preview versions (which can
    // also appear as dropdown options), so match all occurrences.
    expect((await screen.findAllByText('0.2.0')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.2.3').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Update mobile preview/i })).toBeEnabled();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('lists the MOBILE-PREVIEW release feed (not core/frontend) in the target dropdown', async () => {
    const client = makeFakeClient();
    const spy = vi.spyOn(client, 'listVersions');
    renderDialog(client);

    await waitFor(() => expect(spy).toHaveBeenCalledWith(undefined, 'mobile-preview'));
    expect(spy).not.toHaveBeenCalledWith(undefined, 'core');
    expect(spy).not.toHaveBeenCalledWith(undefined, 'frontend');
  });

  it('executes the preview-only update after the dry-run', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const execSpy = vi.spyOn(client, 'executeMobilePreviewUpdate');
    const onStarted = vi.fn();
    renderDialog(client, onStarted);

    await user.click(screen.getByRole('button', { name: /Run dry-run/i }));
    await screen.findAllByText('0.2.3');
    await user.click(screen.getByRole('button', { name: /Update mobile preview/i }));

    await waitFor(() => expect(execSpy).toHaveBeenCalledWith('clinic-a', {}));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });

  it('blocks execution when an installed plugin is mobile-incompatible with the target preview', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({
      mobilePreviewDryRunPlan: {
        instanceId: 'clinic-a',
        kind: 'mobile-preview',
        currentMobilePreviewVersion: '0.2.0',
        targetMobilePreviewVersion: '0.2.3',
        status: 'ok',
        mobilePreview: { id: 'selfhelp-mobile-preview-0.2.3', version: '0.2.3' },
        reasons: [],
        steps: ['snapshot config', 'pull mobile-preview image (0.2.3)'],
        pluginGate: {
          status: 'blocked',
          evaluations: [
            {
              pluginId: 'sh-shp-survey-js',
              verdict: 'incompatible',
              message: 'sh-shp-survey-js requires mobile renderer ">=0.3.0" but the preview image ships 0.1.0.',
            },
          ],
        },
      },
    });
    const execSpy = vi.spyOn(client, 'executeMobilePreviewUpdate');
    renderDialog(client);

    await user.click(screen.getByRole('button', { name: /Run dry-run/i }));
    expect(await screen.findByText('incompatible')).toBeInTheDocument();
    // The native-renderer incompatibility keeps the swap disabled.
    expect(screen.getByRole('button', { name: /Update mobile preview/i })).toBeDisabled();
    expect(execSpy).not.toHaveBeenCalled();
  });
});
