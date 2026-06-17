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
import { Code, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, EmptyState, PaginationFooter, Spinner, StatusBadge, TextField, type BadgeTone } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { BackupOrigin, BackupSummary } from '../../lib/types';
import { usePagination } from '../../lib/use-pagination';
import { managerFallbackInterval, useManagerSseConnected } from './manager-sse-status';
import { formatBytes } from './backup-format';
import { BackupScheduleCard } from './BackupScheduleCard';

const ORIGIN_LABEL: Record<BackupOrigin, string> = {
  manual: 'manual',
  scheduled: 'scheduled',
  pre_update: 'pre-update',
  pre_restore: 'pre-restore',
};

const ORIGIN_TONE: Record<BackupOrigin, BadgeTone> = {
  manual: 'info',
  scheduled: 'ok',
  pre_update: 'warning',
  pre_restore: 'neutral',
};

function OriginBadge({ origin }: { origin: BackupOrigin }): JSX.Element {
  // Origin is a category, not a live status, so no leading dot — but it reuses
  // the standard non-truncating pill so the column never clips.
  return (
    <StatusBadge tone={ORIGIN_TONE[origin]} dot={false}>
      {ORIGIN_LABEL[origin]}
    </StatusBadge>
  );
}

export interface BackupManagerProps {
  client: ApiClient;
  instanceId: string;
  /** Disable mutations while another operation holds the instance lock. */
  busy: boolean;
  onStarted: (operationId: string) => void;
}

export function BackupManager({ client, instanceId, busy, onStarted }: BackupManagerProps): JSX.Element {
  const [restoreTarget, setRestoreTarget] = useState<BackupSummary | null>(null);
  const [typed, setTyped] = useState('');
  const sseConnected = useManagerSseConnected();

  const query = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'backups'],
    queryFn: () => client.listBackups(instanceId),
    refetchInterval: managerFallbackInterval(sseConnected, 15_000),
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
  const backupsPage = usePagination(backups, 25);
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
                  {backupsPage.pageItems.map((b) => (
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
              <PaginationFooter
                page={backupsPage.page}
                pageCount={backupsPage.pageCount}
                onPageChange={backupsPage.setPage}
                total={backupsPage.total}
                range={backupsPage.range}
                noun="backups"
              />
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

      <BackupScheduleCard client={client} instanceId={instanceId} busy={busy} onStarted={onStarted} />
    </>
  );
}
