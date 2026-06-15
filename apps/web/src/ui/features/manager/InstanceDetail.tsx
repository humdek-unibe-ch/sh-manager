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
import { useState } from 'react';
import { Anchor, Badge, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, EmptyState, KeyValue, Spinner, StatusBadge } from '../../components';
import { ApiError, type ApiClient, type InstanceHealthReport } from '../../lib/api-client';
import type { OperationRecord } from '../../lib/types';
import { BackupManager } from './BackupManager';
import { CloneInstanceDialog } from './CloneInstanceDialog';
import { EnvDialog } from './EnvDialog';
import { InstanceUpdateDialog } from './InstanceUpdateDialog';
import { MailerDialog } from './MailerDialog';
import { OperationLog, operationTone } from './OperationLog';
import { RemoveInstanceDialog } from './RemoveInstanceDialog';
import { SetAddressDialog } from './SetAddressDialog';
import { instanceStatusTone } from './InstancesList';

type DialogKind = 'update' | 'clone' | 'address' | 'mailer' | 'env' | 'remove' | null;

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

  const detailQuery = useQuery({
    queryKey: ['manager', 'instance', instanceId],
    queryFn: () => client.getInstance(instanceId),
    refetchInterval: 10_000,
  });

  const operationsQuery = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'operations'],
    queryFn: () => client.listOperations(instanceId),
    refetchInterval: 5_000,
  });

  const health = useMutation({ mutationFn: () => client.runInstanceHealth(instanceId) });

  const detail = detailQuery.data ?? null;
  const summary = detail?.summary ?? null;
  const busy = summary?.busy != null;
  const operations = operationsQuery.data ?? [];

  const onStarted = (operationId: string): void => {
    setWatchedOperationId(operationId);
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
          <Button variant="secondary" disabled={busy} onClick={() => setDialog('address')}>
            Change address…
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDialog('mailer')}>
            Email…
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDialog('env')}>
            Environment…
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
                <Badge
                  color={s.state === 'healthy' ? 'teal' : s.required ? 'red' : 'gray'}
                  variant="light"
                  styles={{ label: { textTransform: 'none' } }}
                >
                  {s.state}
                </Badge>
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
                {operations.map((op: OperationRecord) => (
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
          </Table.ScrollContainer>
        )}
      </Card>

      <InstanceUpdateDialog
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
