// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Scheduled-backups card: nightly schedule + grandfather-father-son retention.
 *
 * Mirrors the server state (GET /backup-schedule) and submits the COMPLETE
 * policy; the server validates it authoritatively. "Preview cleanup" plans a
 * prune without deleting; "Apply retention now" runs it through the job layer.
 */
import { useState } from 'react';
import { Group, NumberInput, Stack, Switch, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Spinner, StatusBadge, TextField } from '../../components';
import { ApiError } from '../../lib/api-client';
import type { BackupSchedulePolicy } from '../../lib/types';
import { managerFallbackInterval, useManagerSseConnected } from './manager-sse-status';
import { formatBytes } from './backup-format';
import type { BackupManagerProps } from './BackupManager';

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

export function BackupScheduleCard({ client, instanceId, busy, onStarted }: BackupManagerProps): JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [pruneSummary, setPruneSummary] = useState<string | null>(null);
  const sseConnected = useManagerSseConnected();

  const query = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'backup-schedule'],
    queryFn: () => client.getBackupSchedule(instanceId),
    refetchInterval: managerFallbackInterval(sseConnected, 30_000),
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
                label="Run time (server local)"
                type="time"
                value={effective.time}
                onChange={(v) => edit({ time: v })}
                help="Pick the hour:minute the nightly backup runs."
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

            <Group gap="sm" align="center">
              <Button
                loading={save.isPending}
                disabled={busy || draft === null}
                onClick={() => save.mutate(draftToPolicy(effective))}
              >
                Save schedule
              </Button>
              {draft !== null ? (
                <StatusBadge tone="warning" dot={false}>
                  Unsaved changes
                </StatusBadge>
              ) : save.isSuccess ? (
                <StatusBadge tone="ok" dot={false}>
                  Saved
                </StatusBadge>
              ) : null}
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
