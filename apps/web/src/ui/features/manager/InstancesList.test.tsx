// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Instances list: rows, status / broken / busy badges and the open action.
 *
 * Split out of the original `InstanceManagement.test.tsx`; renders through the
 * shared Mantine-aware `../../test/render` and the in-memory
 * `../../test/fake-client`. The test bodies are unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, userEvent } from '../../test/render';
import { InstancesList } from './InstancesList';
import { makeFakeClient, fakeInstance } from '../../test/fake-client';

describe('InstancesList', () => {
  it('lists instances with status and surfaces broken ones with a repair hint', async () => {
    const client = makeFakeClient({
      instances: [
        fakeInstance(),
        fakeInstance({
          instanceId: 'ghost',
          displayName: null,
          status: 'broken',
          version: null,
          brokenReason: 'Instance manifest missing or invalid. Run: sh-manager instance repair ghost',
        }),
      ],
    });
    render(<InstancesList client={client} onOpen={() => {}} onCreate={() => {}} />);

    expect(await screen.findByText('clinic-a')).toBeInTheDocument();
    expect(screen.getByText('ghost')).toBeInTheDocument();
    expect(screen.getByText('broken')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    // Security guidance is always visible on the instances overview.
    expect(screen.getByText(/SSH tunnel/i)).toBeInTheDocument();
  });

  it('marks instances locked by a running operation as busy', async () => {
    const client = makeFakeClient({
      instances: [
        fakeInstance({ busy: { operationId: 'op-7', acquiredAt: '2026-06-01T10:00:00.000Z' } }),
      ],
    });
    render(<InstancesList client={client} onOpen={() => {}} onCreate={() => {}} />);

    expect(await screen.findByText('busy')).toBeInTheDocument();
  });

  it('opens an instance through the row link', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<InstancesList client={makeFakeClient()} onOpen={onOpen} onCreate={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'clinic-a' }));
    expect(onOpen).toHaveBeenCalledWith('clinic-a');
  });
});
