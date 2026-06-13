// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Backups card: list (metadata from each backup manifest), create, restore —
 * plus the nightly schedule + GFS retention card.
 *
 * - Backups capture the CURRENT state and record selfhelp + migration versions
 *   in the manifest — there is no "dump at a specific version".
 * - Every backup carries its origin (manual / scheduled / pre-update /
 *   pre-restore); retention treats them differently, the list shows a badge.
 * - The schedule card mirrors the server state (GET /backup-schedule) and
 *   submits the COMPLETE policy; the server validates it authoritatively.
 * - No browser download in this phase: the card shows the server-side path.
 * - Restore always takes an automatic pre-restore backup first (job layer),
 *   and requires typing `restore <backupId>` to confirm.
 */
import { useState } from 'react';
import { Badge, Code, Group, Modal, NumberInput, Stack, Switch, Table, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, EmptyState, Spinner, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { BackupOrigin, BackupSchedulePolicy, BackupSummary } from '../../lib/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

const ORIGIN_LABEL: Record<BackupOrigin, string> = {
  manual: 'manual',
  scheduled: 'scheduled',
  pre_update: 'pre-update',
  pre_restore: 'pre-restore',
};

const ORIGIN_COLOR: Record<BackupOrigin, string> = {
  manual: 'blue',
  scheduled: 'green',
  pre_update: 'orange',
  pre_restore: 'grape',
};

function OriginBadge({ origin }: { origin: BackupOrigin }): JSX.Element {
  return (
    <Badge size="sm" variant="light" color={ORIGIN_COLOR[origin]}>
      {ORIGIN_LABEL[origin]}
    </Badge>
  );
}

export interface BackupManagerProps {
  client: ApiClient;
  instanceId: string;
  /** Disable mutations while another operation holds the instance lock. */
  busy: boolean;
  onStarted: (operationId: string) => void;
}

/** Editable mirror of the schedule policy (a complete policy is submitted). */
interface ScheduleDraft {
  enabled: boolean;
  time: string;
  daily: number | string;
  weekly: number | string;
  monthly: number | string;
  maxAgeDays: number | string;
}

const DEFAULT_DRAFT: ScheduleDraft = { enabled: false, time: '02:00', daily: 7, weekly: 5, monthly: 12, maxAgeDays: 365 };

function draftToPolicy(d: ScheduleDraft): BackupSchedulePolicy {
  return {
    enabled: d.enabled,
    time: d.time,
    retention: {
      daily: Number(d.daily),
      weekly: Number(d.weekly),
      monthly: Number(d.monthly),
      maxAgeDays: Number(d.maxAgeDays),
    },
  };
}

function ScheduleCard({ client, instanceId, busy, onStarted }: BackupManagerProps): JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [pruneSummary, setPruneSummary] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'backup-schedule'],
    queryFn: () => client.getBackupSchedule(instanceId),
    refetchInterval: 30_000,
  });

  const save = useMutation({
    mutationFn: (policy: BackupSchedulePolicy) => client.setBackupSchedule(instanceId, policy),
    onSuccess: (status) => {
      queryClient.setQueryData(['manager', 'instance', instanceId, 'backup-schedule'], status);
      setDraft(null); // re-mirror the (authoritative) server state
    },
  });

  const preview = useMutation({
    mutationFn: () => client.previewBackupPrune(instanceId),
    onSuccess: (report) => {
      const deletions = report.plan.prune;
      setPruneSummary(
        deletions.length === 0
          ? `Nothing to clean up: all ${report.plan.keep.length} backups are retained by the policy.`
          : `${report.plan.keep.length} kept, ${deletions.length} deleted: ${deletions.map((d) => d.backupId).join(', ')}`,
      );
    },
  });

  const prune = useMutation({
    mutationFn: () => client.pruneBackups(instanceId),
    onSuccess: (res) => onStarted(res.operationId),
  });

  const status = query.data;
  // The form mirrors the server policy until the operator edits it.
  const effective: ScheduleDraft =
    draft ??
    (status?.policy
      ? {
          enabled: status.policy.enabled,
          time: status.policy.time,
          daily: status.policy.retention.daily,
          weekly: status.policy.retention.weekly,
          monthly: status.policy.retention.monthly,
          maxAgeDays: status.policy.retention.maxAgeDays,
        }
      : DEFAULT_DRAFT);

  const edit = (patch: Partial<ScheduleDraft>): void => setDraft({ ...effective, ...patch });

  return (
    <Card
      title="Scheduled backups"
      description="Nightly backups with grandfather-father-son retention: recent days in full, then Mondays, then 1st-of-month snapshots. Manual backups are never auto-deleted; pre-update/pre-restore safety backups only past the maximum age."
    >
      <Stack gap="sm">
        {query.isPending ? (
          <Group justify="center" py="md">
            <Spinner label="Loading schedule" />
          </Group>
        ) : query.isError ? (
          <Alert tone="error" title="Could not load the backup schedule">
            {query.error instanceof ApiError ? query.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : (
          <>
            <Group gap="xl" wrap="wrap">
              <Switch
                label="Take a backup every night"
                checked={effective.enabled}
                disabled={busy}
                onChange={(e) => edit({ enabled: e.currentTarget.checked })}
              />
              <TextField
                label="Run time (server local, HH:MM)"
                value={effective.time}
                onChange={(v) => edit({ time: v })}
                placeholder="02:00"
              />
            </Group>
            <Group gap="md" wrap="wrap">
              <NumberInput
                label="Daily backups"
                description="most recent days"
                value={effective.daily}
                onChange={(v) => edit({ daily: v })}
                min={1}
                max={90}
                w={140}
              />
              <NumberInput
                label="Weekly (Mondays)"
                description="kept after the dailies"
                value={effective.weekly}
                onChange={(v) => edit({ weekly: v })}
                min={0}
                max={52}
                w={140}
              />
              <NumberInput
                label="Monthly (1st)"
                description="kept after the weeklies"
                value={effective.monthly}
                onChange={(v) => edit({ monthly: v })}
                min={0}
                max={60}
                w={140}
              />
              <NumberInput
                label="Max age (days)"
                description="hard delete beyond this"
                value={effective.maxAgeDays}
                onChange={(v) => edit({ maxAgeDays: v })}
                min={7}
                max={3650}
                w={150}
              />
            </Group>

            {save.isError ? (
              <Alert tone="error" title="Schedule not saved">
                {save.error instanceof ApiError ? save.error.message : 'The manager service did not answer.'}
              </Alert>
            ) : null}

            <Group gap="sm">
              <Button
                loading={save.isPending}
                disabled={busy || draft === null}
                onClick={() => save.mutate(draftToPolicy(effective))}
              >
                Save schedule
              </Button>
              <Button variant="ghost" loading={preview.isPending} onClick={() => preview.mutate()}>
                Preview cleanup
              </Button>
              <Button
                variant="secondary"
                loading={prune.isPending}
                disabled={busy}
                onClick={() => prune.mutate()}
              >
                Apply retention now
              </Button>
            </Group>

            {pruneSummary ? (
              <Alert tone="info" title="Retention preview (nothing was deleted)">
                {pruneSummary}
              </Alert>
            ) : null}
            {prune.isError ? (
              <Alert tone="error" title="Could not start the cleanup">
                {prune.error instanceof ApiError ? prune.error.message : 'The manager service did not answer.'}
              </Alert>
            ) : null}

            <Group gap="xl" wrap="wrap">
              <Text size="sm" c="dimmed">
                Last run:{' '}
                <Text span size="sm" c="var(--mantine-color-text)">
                  {status?.lastRunAt ? `${new Date(status.lastRunAt).toLocaleString()} (${status.lastResult})` : 'never'}
                </Text>
              </Text>
              <Text size="sm" c="dimmed">
                Next run:{' '}
                <Text span size="sm" c="var(--mantine-color-text)">
                  {status?.nextRunAt ? new Date(status.nextRunAt).toLocaleString() : '—'}
                </Text>
              </Text>
              <Text size="sm" c="dimmed">
                On disk:{' '}
                <Text span size="sm" c="var(--mantine-color-text)">
                  {status ? `${status.backups.count} backups, ${formatBytes(status.backups.totalBytes)}` : '—'}
                </Text>
              </Text>
              <Text size="sm" c="dimmed">
                Projected steady state:{' '}
                <Text span size="sm" c="var(--mantine-color-text)">
                  {status
                    ? `~${formatBytes(status.footprint.steadyStateBytes)} (${status.footprint.slots} slots x ${formatBytes(status.footprint.averageBackupBytes)})`
                    : '—'}
                </Text>
              </Text>
            </Group>
            {status?.lastDetail ? (
              <Alert tone="warning" title="Last scheduled run reported a problem">
                {status.lastDetail}
              </Alert>
            ) : null}
          </>
        )}
      </Stack>
    </Card>
  );
}

export function BackupManager({ client, instanceId, busy, onStarted }: BackupManagerProps): JSX.Element {
  const [restoreTarget, setRestoreTarget] = useState<BackupSummary | null>(null);
  const [typed, setTyped] = useState('');

  const query = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'backups'],
    queryFn: () => client.listBackups(instanceId),
    refetchInterval: 15_000,
  });

  const createBackup = useMutation({
    mutationFn: () => client.createBackup(instanceId),
    onSuccess: (res) => onStarted(res.operationId),
  });

  const restore = useMutation({
    mutationFn: (backupId: string) => client.restoreBackup(instanceId, backupId),
    onSuccess: (res) => {
      setRestoreTarget(null);
      setTyped('');
      onStarted(res.operationId);
    },
  });

  const backups = query.data ?? [];
  const expected = restoreTarget ? `restore ${restoreTarget.backupId}` : '';

  return (
    <>
      <Card
        title="Backups"
        description="Each backup captures the database, uploads, plugin artifacts and secrets, tagged with the versions it was taken at. Files stay on the server — there is no browser download."
        aside={
          <Button variant="secondary" loading={createBackup.isPending} disabled={busy} onClick={() => createBackup.mutate()}>
            Create backup
          </Button>
        }
      >
        <Stack gap="sm">
          {createBackup.isError ? (
            <Alert tone="error" title="Could not start the backup">
              {createBackup.error instanceof ApiError
                ? createBackup.error.message
                : 'The manager service did not answer.'}
            </Alert>
          ) : null}

          {query.isPending ? (
            <Group justify="center" py="md">
              <Spinner label="Loading backups" />
            </Group>
          ) : query.isError ? (
            <Alert tone="error" title="Could not load backups">
              {query.error instanceof ApiError ? query.error.message : 'The manager service did not answer.'}
            </Alert>
          ) : backups.length === 0 ? (
            <EmptyState icon="🗄️" title="No backups yet">
              Create the first backup before risky changes — updates also take one automatically.
            </EmptyState>
          ) : (
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Backup</Table.Th>
                    <Table.Th>Origin</Table.Th>
                    <Table.Th>Created</Table.Th>
                    <Table.Th>Versions</Table.Th>
                    <Table.Th>Contents</Table.Th>
                    <Table.Th>Size</Table.Th>
                    <Table.Th aria-label="Actions" />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {backups.map((b) => (
                    <Table.Tr key={b.backupId}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {b.backupId}
                        </Text>
                        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                          {b.backupDir}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <OriginBadge origin={b.origin} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{new Date(b.createdAt).toLocaleString()}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {b.selfhelpVersion}
                          <Text span size="xs" c="dimmed">
                            {' '}
                            / {b.migrationVersion}
                          </Text>
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {b.includedAreas.join(', ')}
                          {b.pluginCount > 0 ? ` (+${b.pluginCount} plugins)` : ''}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{formatBytes(b.totalBytes)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Button variant="ghost" disabled={busy} onClick={() => setRestoreTarget(b)}>
                          Restore…
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>

        <Modal
          opened={restoreTarget !== null}
          onClose={() => {
            setRestoreTarget(null);
            setTyped('');
          }}
          title={`Restore ${restoreTarget?.backupId ?? ''}`}
          size="lg"
          centered
        >
          {restoreTarget ? (
            <Stack gap="md">
              <Alert tone="warning" title="The current state will be replaced">
                The instance is rolled back to {restoreTarget.selfhelpVersion} (
                {new Date(restoreTarget.createdAt).toLocaleString()}). An automatic pre-restore backup of the
                CURRENT state is taken first, so this step is recoverable. Type <Code>{expected}</Code> to
                confirm.
              </Alert>
              <TextField label="Type the confirmation" value={typed} onChange={setTyped} placeholder={expected} />
              {restore.isError ? (
                <Alert tone="error" title="Could not start the restore">
                  {restore.error instanceof ApiError ? restore.error.message : 'The manager service did not answer.'}
                </Alert>
              ) : null}
              <Group justify="flex-end" gap="sm">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setRestoreTarget(null);
                    setTyped('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={typed !== expected}
                  loading={restore.isPending}
                  onClick={() => restore.mutate(restoreTarget.backupId)}
                >
                  Restore this backup
                </Button>
              </Group>
            </Stack>
          ) : null}
        </Modal>
      </Card>

      <ScheduleCard client={client} instanceId={instanceId} busy={busy} onStarted={onStarted} />
    </>
  );
}
