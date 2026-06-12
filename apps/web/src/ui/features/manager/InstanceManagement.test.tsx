// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * GUI instance management flows: list (incl. broken/busy states), detail with
 * health + backups + operation history, the dry-run-gated update, the typed
 * confirmations on restore and full delete, and the create flow with a live
 * operation log. All flows run against the in-memory fake ApiClient, which
 * mirrors the BFF contract (202 + operation journal).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within, userEvent } from '../../test/render';
import { OperationsConsole } from './OperationsConsole';
import { InstanceDetail } from './InstanceDetail';
import { InstancesList } from './InstancesList';
import { OperationLog } from './OperationLog';
import { makeFakeClient, fakeInstance, fakeOperation } from '../../test/fake-client';

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

describe('InstanceDetail', () => {
  it('shows the overview, backups and operation history for an instance', async () => {
    const client = makeFakeClient({
      operations: [fakeOperation({ id: 'op-9', kind: 'instance_update', status: 'failed', error: 'Health gate failed.' })],
    });
    render(<InstanceDetail client={client} instanceId="clinic-a" onBack={() => {}} />);

    expect(await screen.findByText('clinic-a')).toBeInTheDocument();
    expect(screen.getByText('clinic-a.example')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    // Backups card with manifest metadata.
    expect(await screen.findByText('bk-20260601-1000')).toBeInTheDocument();
    expect(screen.getByText(/db, uploads, config/)).toBeInTheDocument();
    expect(screen.getByText('12.0 MiB')).toBeInTheDocument();
    // Operation history shows the failed update.
    expect(screen.getByText('instance update')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('runs a health check on demand and renders the per-service report', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /run health check/i }));

    expect(await screen.findByText('healthy')).toBeInTheDocument();
    expect(screen.getByText('backend')).toBeInTheDocument();
    expect(screen.getByText(/redis/)).toBeInTheDocument();
  });

  it('requires a dry-run and an explicit risk acknowledgement before an update can execute', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /update…/i }));
    const dialog = await screen.findByRole('dialog');

    // Execute is locked until a dry-run produced a plan AND the risk box is ticked.
    const executeButton = within(dialog).getByRole('button', { name: /execute update/i });
    expect(executeButton).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: /run dry-run/i }));
    expect(await within(dialog).findByText('0.2.0')).toBeInTheDocument();
    expect(within(dialog).getByText(/run migrations/)).toBeInTheDocument();
    expect(executeButton).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox', { name: /I understand the migration risk/i }));
    expect(executeButton).toBeEnabled();

    await user.click(executeButton);
    // The started operation surfaces with its journaled log.
    expect(await screen.findByText('Operation in progress')).toBeInTheDocument();
    expect(await screen.findByText(/instance_update finished/)).toBeInTheDocument();
  });

  it('requires typing the exact confirmation before a restore starts (with auto pre-restore backup note)', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /restore…/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/pre-restore backup/i)).toBeInTheDocument();
    const restoreButton = within(dialog).getByRole('button', { name: /restore this backup/i });
    expect(restoreButton).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/type the confirmation/i), 'restore bk-20260601-1000');
    expect(restoreButton).toBeEnabled();

    await user.click(restoreButton);
    expect(await screen.findByText(/instance_restore finished/)).toBeInTheDocument();
  });

  it('full delete demands the typed "delete <id>" confirmation; disable does not', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /remove…/i }));
    const dialog = await screen.findByRole('dialog');

    // Default mode (disable) needs no typed confirmation.
    expect(within(dialog).getByRole('button', { name: /disable instance/i })).toBeEnabled();

    await user.click(within(dialog).getByRole('radio', { name: /full delete/i }));
    const deleteButton = within(dialog).getByRole('button', { name: /delete instance/i });
    expect(deleteButton).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/type the confirmation/i), 'delete clinic-a');
    expect(deleteButton).toBeEnabled();

    await user.click(deleteButton);
    expect(await screen.findByText(/instance_remove finished/)).toBeInTheDocument();
  });

  it('clone always announces fresh secrets and validates the target id', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /clone…/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/fresh secrets/i)).toBeInTheDocument();
    const cloneButton = within(dialog).getByRole('button', { name: /clone instance/i });
    expect(cloneButton).toBeDisabled();

    // Same id as the source is rejected.
    await user.type(within(dialog).getByLabelText(/new instance id/i), 'clinic-a');
    await user.type(within(dialog).getByLabelText(/new domain/i), 'staging.example.org');
    expect(await within(dialog).findByText(/different instance id/i)).toBeInTheDocument();
    expect(cloneButton).toBeDisabled();

    await user.clear(within(dialog).getByLabelText(/new instance id/i));
    await user.type(within(dialog).getByLabelText(/new instance id/i), 'clinic-b');
    expect(cloneButton).toBeEnabled();

    await user.click(cloneButton);
    expect(await screen.findByText(/instance_clone finished/)).toBeInTheDocument();
  });
});

describe('OperationLog', () => {
  it('renders the journaled log lines and the failure message', async () => {
    const client = makeFakeClient({
      operations: [
        fakeOperation({
          id: 'op-fail',
          kind: 'instance_update',
          status: 'failed',
          log: ['backup: ok', 'migrate: error'],
          error: 'Migration Version123 failed; instance rolled back.',
          result: null,
        }),
      ],
    });
    render(<OperationLog client={client} operationId="op-fail" />);

    expect(await screen.findByText(/backup: ok/)).toBeInTheDocument();
    expect(screen.getByText(/migrate: error/)).toBeInTheDocument();
    expect(screen.getByText('Operation failed')).toBeInTheDocument();
    expect(screen.getByText(/rolled back/i)).toBeInTheDocument();
  });
});

describe('OperationsConsole instance flows', () => {
  it('navigates from the list to the instance detail and back', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    await user.click(await screen.findByRole('button', { name: 'clinic-a' }));
    expect(await screen.findByText('Operation history')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back to instances/i }));
    expect(await screen.findByText('Server operations')).toBeInTheDocument();
  });

  it('creates an instance from the GUI and watches the journaled operation', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    await user.click(await screen.findByRole('button', { name: /new instance/i }));
    const dialog = await screen.findByRole('dialog');

    // The admin password is explicitly NOT shown in the browser.
    expect(within(dialog).getByText(/never shown here/i)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/instance id/i), 'website1');
    await user.type(within(dialog).getByLabelText(/display name/i), 'Website One');
    await user.type(within(dialog).getByLabelText(/domain/i), 'site.example.org');
    await user.type(within(dialog).getByLabelText(/admin email/i), 'admin@example.org');
    await user.click(within(dialog).getByRole('button', { name: /create instance/i }));

    expect(await screen.findByText('Instance creation in progress')).toBeInTheDocument();
    expect(await screen.findByText(/instance_create finished/)).toBeInTheDocument();
    // The new instance appears in the list (fake mirrors the real inventory write).
    await waitFor(() => expect(screen.getByText('website1')).toBeInTheDocument());
  });
});
