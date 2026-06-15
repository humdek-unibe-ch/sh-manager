// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Rename dialog: prefills the current display name, keeps the technical id
 * read-only, rejects an empty name, and applies the new name through the
 * journaled BFF job. All against the in-memory fake ApiClient.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { RenameInstanceDialog } from './RenameInstanceDialog';
import { makeFakeClient } from '../../test/fake-client';

function renderDialog(currentName: string | null = 'Clinic A', onStarted = vi.fn()) {
  const client = makeFakeClient();
  render(
    <RenameInstanceDialog
      client={client}
      instanceId="clinic-a"
      currentName={currentName}
      opened
      onClose={() => {}}
      onStarted={onStarted}
    />,
  );
  return { client, onStarted };
}

describe('RenameInstanceDialog', () => {
  it('prefills the current name, keeps the id visible, and disables rename when emptied', async () => {
    const user = userEvent.setup();
    renderDialog('Clinic A');

    const input = (await screen.findByLabelText(/Display name/i)) as HTMLInputElement;
    expect(input.value).toBe('Clinic A');
    // The immutable technical id is shown for reference.
    expect(screen.getByText('clinic-a')).toBeInTheDocument();

    await user.clear(input);
    expect(screen.getByRole('button', { name: /^Rename$/i })).toBeDisabled();
  });

  it('applies the trimmed new display name through the journaled job', async () => {
    const user = userEvent.setup();
    const { client, onStarted } = renderDialog('Clinic A');
    const spy = vi.spyOn(client, 'setInstanceName');

    const input = await screen.findByLabelText(/Display name/i);
    await user.clear(input);
    await user.type(input, '  Renamed Clinic  ');
    await user.click(screen.getByRole('button', { name: /^Rename$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith('clinic-a', { displayName: 'Renamed Clinic' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });
});
