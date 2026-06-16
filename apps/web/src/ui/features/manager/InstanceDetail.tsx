// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance detail page: live status header, on-demand health check, backups
 * (create/restore), update with mandatory dry-run, clone, staged remove, and
 * the full operation history with live logs — everything an operator
 * previously had to SSH in for.
 *
 * Every mutation goes through the BFF job layer (202 + journal + per-instance
 * lock + audit). The page polls the journal, so progress is visible here AND
 * survives a browser reload.
 */
import { useEffect, useRef, useState } from 'react';
import { Anchor, Code, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { Alert, Button, Card, EmptyState, KeyValue, PaginationFooter, Spinner, StatusBadge } from '../../components';
import { ApiError, type ApiClient, type InstanceHealthReport } from '../../lib/api-client';
import type { OperationRecord } from '../../lib/types';
import { usePagination } from '../../lib/use-pagination';
import { BackupManager } from './BackupManager';
import { CloneInstanceDialog } from './CloneInstanceDialog';
import { EnvDialog } from './EnvDialog';
import { LogsDialog } from './LogsDialog';
import { UpdateDialog } from './UpdateDialog';
import { MailerDialog } from './MailerDialog';
import { OperationLog, operationTone } from './OperationLog';
import { RemoveInstanceDialog } from './RemoveInstanceDialog';
import { RenameInstanceDialog } from './RenameInstanceDialog';
import { SetAddressDialog } from './SetAddressDialog';
import { INSTANCES_KEY, instanceStatusTone } from './InstancesList';
import { managerFallbackInterval, useManagerSseConnected } from './manager-sse-status';

type DialogKind = 'update' | 'clone' | 'rename' | 'address' | 'mailer' | 'env' | 'logs' | 'remove' | null;

function healthTone(overall: InstanceHealthReport['overall']): 'ok' | 'warning' | 'error' | 'neutral' {
  switch (overall) {
    case 'healthy':
      return 'ok';
    case 'degraded':
      return 'warning';
    case 'unhealthy':
      return 'error';
    default:
      return 'neutral';
  }
}

export interface InstanceDetailProps {
  client: ApiClient;
  instanceId: string;
}

export function InstanceDetail({ client, instanceId }: InstanceDetailProps): JSX.Element {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [watchedOperationId, setWatchedOperationId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // SSE-driven: the `/api/events` stream invalidates these queries live, so the
  // fallback poll only runs while the stream is disconnected.
  const sseConnected = useManagerSseConnected();

  const detailQuery = useQuery({
    queryKey: ['manager', 'instance', instanceId],
    queryFn: () => client.getInstance(instanceId),
    refetchInterval: managerFallbackInterval(sseConnected, 10_000),
  });

  const operationsQuery = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'operations'],
    queryFn: () => client.listOperations(instanceId),
    refetchInterval: managerFallbackInterval(sseConnected, 5_000),
  });

  // Watch the in-progress operation here too (shares <OperationLog/>'s query
  // key, so it's a single poll). The moment it reaches a terminal state we
  // refresh EVERY query scoped to this instance — detail, operations, backups,
  // schedule, mailer, env — so the whole view reflects the new state without
  // waiting for the next interval tick, and the operator gets a toast. The poll
  // only runs while SSE is down AND the operation is still running.
  const watchedQuery = useQuery({
    queryKey: ['manager', 'operation', watchedOperationId],
    queryFn: () => client.getOperation(watchedOperationId as string),
    enabled: watchedOperationId !== null,
    refetchInterval: (q) => (!sseConnected && q.state.data?.status === 'running' ? 2_000 : false),
  });

  const refreshInstance = (): void => {
    // Prefix-invalidate the detail AND every sub-query (operations/backups/
    // schedule/mailer/env all share this prefix)…
    void queryClient.invalidateQueries({ queryKey: ['manager', 'instance', instanceId] });
    // …and the left-hand instances list, whose display name / version / status
    // this view changes (rename, update, address, remove) — otherwise the list
    // stays stale until a full page reload.
    void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
  };

  const notifiedOpRef = useRef<string | null>(null);
  useEffect(() => {
    const op = watchedQuery.data;
    if (!op || op.status === 'running') return;
    if (notifiedOpRef.current === op.id) return;
    notifiedOpRef.current = op.id;
    void queryClient.invalidateQueries({ queryKey: ['manager', 'instance', instanceId] });
    // Refresh the left-hand list too: a finished rename/update/address change is
    // visible there (name, version, status), not just on this detail page.
    void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
    const label = op.kind.replace(/_/g, ' ');
    if (op.status === 'succeeded') {
      notifications.show({ color: 'teal', title: 'Operation finished', message: `${label} completed.` });
    } else if (op.status === 'failed') {
      notifications.show({
        color: 'red',
        title: 'Operation failed',
        message: op.error ?? `${label} failed.`,
        autoClose: 8_000,
      });
    }
  }, [watchedQuery.data, instanceId, queryClient]);

  const health = useMutation({ mutationFn: () => client.runInstanceHealth(instanceId) });

  const detail = detailQuery.data ?? null;
  const summary = detail?.summary ?? null;
  const busy = summary?.busy != null;
  const operations = operationsQuery.data ?? [];
  const operationsPage = usePagination(operations, 25);
  const manifest = detail?.manifest ?? null;
  // One row per managed container, pairing the recorded version (where the
  // manifest tracks one) with the resolved image tag/digest.
  const componentRows: { label: string; version: string | null; image: string | null }[] = manifest
    ? [
        { label: 'SelfHelp', version: manifest.versions.selfhelp, image: null },
        { label: 'Backend', version: manifest.versions.backend, image: manifest.images.backend },
        { label: 'Frontend', version: manifest.versions.frontend, image: manifest.images.frontend },
        { label: 'Scheduler', version: manifest.versions.scheduler, image: manifest.images.scheduler },
        { label: 'Worker', version: manifest.versions.worker, image: manifest.images.worker },
        { label: 'Plugin API', version: manifest.versions.pluginApi, image: null },
        { label: 'MySQL', version: null, image: manifest.images.mysql },
        { label: 'Redis', version: null, image: manifest.images.redis },
        { label: 'Mercure', version: null, image: manifest.images.mercure },
      ]
    : [];

  const onStarted = (operationId: string): void => {
    setWatchedOperationId(operationId);
    notifiedOpRef.current = null;
    // Pull in the brand-new journal row immediately (don't wait for the tick).
    refreshInstance();
  };

  if (detailQuery.isPending) {
    return (
      <Group justify="center" py="xl">
        <Spinner size="lg" label="Loading instance" />
      </Group>
    );
  }

  if (detailQuery.isError || !detail || !summary) {
    return (
      <Alert tone="error" title={`Instance "${instanceId}" could not be loaded`}>
        {detailQuery.error instanceof ApiError
          ? detailQuery.error.message
          : 'The manager service did not answer.'}
      </Alert>
    );
  }

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Group gap="sm">
            <Title order={2}>{summary.instanceId}</Title>
            <StatusBadge tone={instanceStatusTone(summary.status)}>{summary.status}</StatusBadge>
            {busy ? <StatusBadge tone="pending">operation running</StatusBadge> : null}
          </Group>
          {summary.displayName ? <Text c="dimmed">{summary.displayName}</Text> : null}
        </div>
        <Group gap="sm">
          <Button variant="secondary" loading={health.isPending} onClick={() => health.mutate()}>
            Run health check
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => setDialog('update')}>
            Update…
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDialog('clone')}>
            Clone…
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDialog('rename')}>
            Rename…
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDialog('address')}>
            Change address…
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDialog('mailer')}>
            Email…
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDialog('env')}>
            Environment…
          </Button>
          {/* Read-only — useful even while an operation runs, so never disabled. */}
          <Button variant="secondary" onClick={() => setDialog('logs')}>
            Logs…
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => setDialog('remove')}>
            Remove…
          </Button>
        </Group>
      </Group>

      {summary.status === 'broken' && summary.brokenReason ? (
        <Alert tone="error" title="This instance needs repair">
          {summary.brokenReason}
        </Alert>
      ) : null}

      <Card title="Overview">
        <KeyValue
          rows={[
            {
              key: 'Domain',
              value: summary.domain ? (
                <Anchor href={summary.domain.startsWith('http') ? summary.domain : `http://${summary.domain}`} target="_blank" rel="noopener noreferrer">
                  {summary.domain}
                </Anchor>
              ) : (
                '—'
              ),
            },
            { key: 'Mode', value: summary.mode ?? '—' },
            { key: 'SelfHelp version', value: summary.version ?? '—' },
            {
              key: 'Last changed',
              value: summary.updatedAt ? new Date(summary.updatedAt).toLocaleString() : '—',
            },
            { key: 'Directory', value: detail.instanceDir, mono: true },
          ]}
        />
      </Card>

      {manifest ? (
        <Card
          title="Components & versions"
          description="Versions and container image tags recorded in this instance's manifest."
        >
          <Table.ScrollContainer minWidth={520}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Component</Table.Th>
                  <Table.Th>Version</Table.Th>
                  <Table.Th>Image</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {componentRows.map((row) => (
                  <Table.Tr key={row.label}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {row.label}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{row.version ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      {row.image ? (
                        <Code style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{row.image}</Code>
                      ) : (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      ) : null}

      {manifest ? (
        <Card
          title="Installed plugins"
          description={
            manifest.installedPlugins.length === 1
              ? '1 plugin recorded in the manifest.'
              : `${manifest.installedPlugins.length} plugins recorded in the manifest.`
          }
        >
          {manifest.installedPlugins.length === 0 ? (
            <EmptyState icon="🧩" title="No plugins installed">
              Plugins installed into this instance will be listed here with their version.
            </EmptyState>
          ) : (
            <Table.ScrollContainer minWidth={360}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Plugin</Table.Th>
                    <Table.Th>Version</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {manifest.installedPlugins.map((plugin) => (
                    <Table.Tr key={plugin.id}>
                      <Table.Td>
                        <Text size="sm">{plugin.id}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Code>{plugin.version}</Code>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Card>
      ) : null}

      {health.isError ? (
        <Alert tone="error" title="Health check failed">
          {health.error instanceof ApiError ? health.error.message : 'The manager service did not answer.'}
        </Alert>
      ) : null}
      {health.data ? (
        <Card
          title="Health"
          aside={<StatusBadge tone={healthTone(health.data.overall)}>{health.data.overall}</StatusBadge>}
          description={`Checked ${new Date(health.data.checkedAt).toLocaleString()}`}
        >
          <Stack gap={6}>
            {health.data.services.map((s) => (
              <Group key={s.service} gap="sm" wrap="nowrap">
                <StatusBadge tone={s.state === 'healthy' ? 'ok' : s.required ? 'error' : 'warning'}>
                  {s.state}
                </StatusBadge>
                <Text size="sm">
                  {s.service}
                  {s.required ? '' : ' (optional)'}
                  {s.detail ? ` — ${s.detail}` : ''}
                </Text>
              </Group>
            ))}
          </Stack>
        </Card>
      ) : null}

      {watchedOperationId ? (
        <Card
          title="Operation in progress"
          aside={
            <Button variant="ghost" onClick={() => setWatchedOperationId(null)}>
              Hide
            </Button>
          }
        >
          <OperationLog client={client} operationId={watchedOperationId} />
        </Card>
      ) : null}

      <BackupManager client={client} instanceId={instanceId} busy={busy} onStarted={onStarted} />

      <Card
        title="Operation history"
        description="Every GUI and background action on this instance, with its full (redacted) log."
        aside={
          <Button variant="ghost" loading={operationsQuery.isFetching} onClick={refreshInstance}>
            Refresh
          </Button>
        }
      >
        {operationsQuery.isPending ? (
          <Group justify="center" py="md">
            <Spinner label="Loading operations" />
          </Group>
        ) : operations.length === 0 ? (
          <EmptyState icon="🪵" title="No operations yet">
            Updates, backups, restores and other actions you start here will appear with live logs.
          </EmptyState>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Operation</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Started</Table.Th>
                  <Table.Th>Finished</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {operationsPage.pageItems.map((op: OperationRecord) => (
                  <Table.Tr key={op.id}>
                    <Table.Td>
                      <Anchor component="button" type="button" size="sm" onClick={() => setWatchedOperationId(op.id)}>
                        {op.kind.replace(/_/g, ' ')}
                      </Anchor>
                      <Text size="xs" c="dimmed">
                        {op.id}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge tone={operationTone(op.status)}>{op.status}</StatusBadge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{new Date(op.startedAt).toLocaleString()}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{op.finishedAt ? new Date(op.finishedAt).toLocaleString() : '—'}</Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <PaginationFooter
              page={operationsPage.page}
              pageCount={operationsPage.pageCount}
              onPageChange={operationsPage.setPage}
              total={operationsPage.total}
              range={operationsPage.range}
              noun="operations"
            />
          </Table.ScrollContainer>
        )}
      </Card>

      <UpdateDialog
        client={client}
        instanceId={instanceId}
        opened={dialog === 'update'}
        onClose={() => setDialog(null)}
        onStarted={onStarted}
      />
      <CloneInstanceDialog
        client={client}
        sourceInstanceId={instanceId}
        sourceMode={summary.mode === 'local' ? 'local' : summary.mode === 'production' ? 'production' : null}
        opened={dialog === 'clone'}
        onClose={() => setDialog(null)}
        onStarted={onStarted}
      />
      <RenameInstanceDialog
        client={client}
        instanceId={instanceId}
        currentName={summary.displayName}
        opened={dialog === 'rename'}
        onClose={() => setDialog(null)}
        onStarted={onStarted}
      />
      <SetAddressDialog
        client={client}
        instanceId={instanceId}
        mode={summary.mode === 'local' ? 'local' : summary.mode === 'production' ? 'production' : null}
        currentAddress={summary.domain ?? ''}
        opened={dialog === 'address'}
        onClose={() => setDialog(null)}
        onStarted={onStarted}
      />
      <MailerDialog
        client={client}
        instanceId={instanceId}
        opened={dialog === 'mailer'}
        onClose={() => setDialog(null)}
        onStarted={onStarted}
      />
      <EnvDialog
        client={client}
        instanceId={instanceId}
        opened={dialog === 'env'}
        onClose={() => setDialog(null)}
        onStarted={onStarted}
      />
      <LogsDialog
        client={client}
        instanceId={instanceId}
        opened={dialog === 'logs'}
        onClose={() => setDialog(null)}
      />
      <RemoveInstanceDialog
        client={client}
        instanceId={instanceId}
        opened={dialog === 'remove'}
        onClose={() => setDialog(null)}
        onStarted={onStarted}
      />
    </Stack>
  );
}
