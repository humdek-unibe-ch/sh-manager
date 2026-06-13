// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Backups card + scheduled-backups card: origin badges on the backup list,
 * schedule rendering from server state, server-identical validation rejecting
 * a bad policy, saving a valid one, and the retention preview / apply-now
 * actions. Everything runs against the in-memory fake ApiClient (which runs
 * the REAL @shm/backup policy validation, like the BFF).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { BackupManager } from './BackupManager';
import { fakeBackup, fakeScheduleStatus, makeFakeClient } from '../../test/fake-client';

describe('BackupManager origin badges', () => {
  it('shows each backup with its origin badge', async () => {
    const client = makeFakeClient({
      backups: {
        'clinic-a': [
          fakeBackup({ backupId: 'backup-20260612-clinic-a-001', origin: 'manual' }),
          fakeBackup({ backupId: 'backup-20260612-clinic-a-002', origin: 'scheduled' }),
          fakeBackup({ backupId: 'backup-20260611-clinic-a-001', origin: 'pre_update' }),
          fakeBackup({ backupId: 'backup-20260610-clinic-a-001', origin: 'pre_restore' }),
        ],
      },
    });
    render(<BackupManager client={client} instanceId="clinic-a" busy={false} onStarted={() => {}} />);

    expect(await screen.findByText('backup-20260612-clinic-a-001')).toBeInTheDocument();
    expect(screen.getByText('manual')).toBeInTheDocument();
    expect(screen.getByText('scheduled')).toBeInTheDocument();
    expect(screen.getByText('pre-update')).toBeInTheDocument();
    expect(screen.getByText('pre-restore')).toBeInTheDocument();
  });
});

describe('Scheduled backups card', () => {
  it('mirrors the server schedule state: policy, last/next run and footprint', async () => {
    const client = makeFakeClient({
      backupSchedules: { 'clinic-a': fakeScheduleStatus() },
    });
    render(<BackupManager client={client} instanceId="clinic-a" busy={false} onStarted={() => {}} />);

    expect(await screen.findByLabelText('Take a backup every night')).toBeChecked();
    expect(screen.getByLabelText(/Run time/)).toHaveValue('02:00');
    expect(screen.getByLabelText('Daily backups')).toHaveValue('7');
    expect(screen.getByLabelText('Weekly (Mondays)')).toHaveValue('5');
    expect(screen.getByLabelText('Monthly (1st)')).toHaveValue('12');
    expect(screen.getByLabelText('Max age (days)')).toHaveValue('365');
    // Run state + size projection from the server status.
    expect(screen.getByText(/3 backups, 36\.0 MiB/)).toBeInTheDocument();
    expect(screen.getByText(/~288\.0 MiB \(24 slots/)).toBeInTheDocument();
    expect(screen.getByText(/succeeded/)).toBeInTheDocument();
  });

  it('rejects an invalid policy with the server-identical validation message', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({ backupSchedules: { 'clinic-a': fakeScheduleStatus() } });
    render(<BackupManager client={client} instanceId="clinic-a" busy={false} onStarted={() => {}} />);

    const time = await screen.findByLabelText(/Run time/);
    await user.clear(time);
    await user.type(time, '25:99');
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByText('Schedule not saved')).toBeInTheDocument();
    expect(screen.getByText(/time must be HH:MM/)).toBeInTheDocument();
  });

  it('saves an edited valid policy back to the server', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({ backupSchedules: { 'clinic-a': fakeScheduleStatus() } });
    const setSpy = vi.spyOn(client, 'setBackupSchedule');
    render(<BackupManager client={client} instanceId="clinic-a" busy={false} onStarted={() => {}} />);

    // Saving is disabled until something is edited (the card mirrors the server).
    const saveButton = await screen.findByRole('button', { name: 'Save schedule' });
    expect(saveButton).toBeDisabled();

    const time = screen.getByLabelText(/Run time/);
    await user.clear(time);
    await user.type(time, '03:30');
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));
    expect(setSpy).toHaveBeenCalledWith('clinic-a', {
      enabled: true,
      time: '03:30',
      retention: { daily: 7, weekly: 5, monthly: 12, maxAgeDays: 365 },
    });
  });

  it('previews the retention plan without deleting and applies it as an operation', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    const client = makeFakeClient({
      backupSchedules: { 'clinic-a': fakeScheduleStatus() },
      prunePreview: {
        plan: {
          keep: [
            { backupId: 'backup-20260612-clinic-a-001', origin: 'scheduled', createdAt: '2026-06-12T02:00:00Z', action: 'keep', reasons: ['daily'] },
          ],
          prune: [
            { backupId: 'backup-20250101-clinic-a-001', origin: 'scheduled', createdAt: '2025-01-01T02:00:00Z', action: 'prune', reasons: ['older-than-max-age'] },
          ],
        },
        deleted: [],
        skipped: [],
        dryRun: true,
      },
    });
    render(<BackupManager client={client} instanceId="clinic-a" busy={false} onStarted={onStarted} />);

    await user.click(await screen.findByRole('button', { name: 'Preview cleanup' }));
    expect(await screen.findByText(/1 kept, 1 deleted: backup-20250101-clinic-a-001/)).toBeInTheDocument();
    expect(screen.getByText(/nothing was deleted/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply retention now' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(String(onStarted.mock.calls[0]![0])).toMatch(/^op-/);
  });
});
