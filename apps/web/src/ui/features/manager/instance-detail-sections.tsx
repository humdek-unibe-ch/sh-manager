// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Presentational cards for the instance detail page. Each is a pure function of
 * its props (the data comes from {@link useInstanceDetail}); they render exactly
 * the markup the page used to inline, so the DOM is unchanged.
 */
import { Anchor, Code, Group, Stack, Table, Text } from '@mantine/core';
import { Alert, Button, Card, EmptyState, PaginationFooter, Spinner, StatusBadge } from '../../components';
import { ApiError, type InstanceHealthReport } from '../../lib/api-client';
import type { OperationRecord } from '../../lib/types';
import { operationKindLabel } from '../../lib/operation-steps';
import { operationTone } from './OperationLog';
import type { useInstanceDetail } from './use-instance-detail';

type Detail = ReturnType<typeof useInstanceDetail>;

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

export function ComponentsCard({
  componentRows,
  anyUpdateAvailable,
  upToDate,
}: {
  componentRows: Detail['componentRows'];
  anyUpdateAvailable: boolean;
  upToDate: boolean;
}): JSX.Element {
  return (
    <Card
      title="Components & versions"
      description="Versions and container image tags recorded in this instance's manifest, with the latest version available from the registry."
      aside={
        anyUpdateAvailable ? (
          <StatusBadge tone="warning">Updates available</StatusBadge>
        ) : upToDate ? (
          <StatusBadge tone="ok" dot={false}>
            Up to date
          </StatusBadge>
        ) : null
      }
    >
      <Table.ScrollContainer minWidth={620}>
        <Table verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Component</Table.Th>
              <Table.Th>Version</Table.Th>
              <Table.Th>Latest version</Table.Th>
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
                  {row.updateAvailable && row.latest ? (
                    <StatusBadge tone="warning">{`${row.latest} available`}</StatusBadge>
                  ) : row.latest ? (
                    <Text size="sm" c="dimmed">
                      {row.latest === row.version ? 'up to date' : row.latest}
                    </Text>
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
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
  );
}

export function PluginsCard({
  loading,
  areLive,
  rows,
  page,
}: {
  loading: boolean;
  areLive: boolean;
  rows: Detail['pluginRows'];
  page: Detail['pluginsPage'];
}): JSX.Element {
  return (
    <Card
      title="Installed plugins"
      description={
        loading
          ? 'Reading plugins from the running instance…'
          : areLive
            ? rows.length === 1
              ? '1 plugin installed (read live from the instance).'
              : `${rows.length} plugins installed (read live from the instance).`
            : 'Instance unreachable — showing the plugins recorded in the manifest.'
      }
    >
      {rows.length === 0 ? (
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
                {areLive ? <Table.Th>Status</Table.Th> : null}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {page.pageItems.map((plugin) => (
                <Table.Tr key={plugin.id}>
                  <Table.Td>
                    <Text size="sm">{plugin.id}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Code>{plugin.version}</Code>
                  </Table.Td>
                  {areLive ? (
                    <Table.Td>
                      <StatusBadge tone={plugin.enabled ? 'ok' : 'neutral'}>
                        {plugin.enabled ? 'Enabled' : 'Disabled'}
                      </StatusBadge>
                    </Table.Td>
                  ) : null}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <PaginationFooter
            page={page.page}
            pageCount={page.pageCount}
            onPageChange={page.setPage}
            total={page.total}
            range={page.range}
            noun="plugins"
          />
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

export function HealthSection({
  isError,
  error,
  data,
}: {
  isError: boolean;
  error: unknown;
  data: InstanceHealthReport | undefined;
}): JSX.Element {
  return (
    <>
      {isError ? (
        <Alert tone="error" title="Health check failed">
          {error instanceof ApiError ? error.message : 'The manager service did not answer.'}
        </Alert>
      ) : null}
      {data ? (
        <Card
          title="Health"
          aside={<StatusBadge tone={healthTone(data.overall)}>{data.overall}</StatusBadge>}
          description={`Checked ${new Date(data.checkedAt).toLocaleString()}`}
        >
          <Stack gap={6}>
            {data.services.map((s) => (
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
    </>
  );
}

export function OperationHistoryCard({
  isPending,
  isFetching,
  operations,
  page,
  onRefresh,
  onOpenOperation,
}: {
  isPending: boolean;
  isFetching: boolean;
  operations: OperationRecord[];
  page: Detail['operationsPage'];
  onRefresh: () => void;
  onOpenOperation: (id: string) => void;
}): JSX.Element {
  return (
    <Card
      title="Operation history"
      description="Every GUI and background action on this instance, with its full (redacted) log."
      aside={
        <Button variant="ghost" loading={isFetching} onClick={onRefresh}>
          Refresh
        </Button>
      }
    >
      {isPending ? (
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
              {page.pageItems.map((op: OperationRecord) => (
                <Table.Tr key={op.id}>
                  <Table.Td>
                    <Anchor component="button" type="button" size="sm" onClick={() => onOpenOperation(op.id)}>
                      {operationKindLabel(op.kind)}
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
            page={page.page}
            pageCount={page.pageCount}
            onPageChange={page.setPage}
            total={page.total}
            range={page.range}
            noun="operations"
          />
        </Table.ScrollContainer>
      )}
    </Card>
  );
}
