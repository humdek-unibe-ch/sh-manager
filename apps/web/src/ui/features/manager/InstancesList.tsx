// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instances overview (persistent mode). Lists every instance the server
 * inventory knows about — including `broken` ones (missing/invalid manifest or
 * uninventoried directory), which surface with a repair hint instead of
 * disappearing. Row click opens the instance detail.
 */
import { Anchor, Group, Stack, Table, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, EmptyState, PaginationFooter, Spinner, StatusBadge, type BadgeTone } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { InstanceSummary } from '../../lib/types';
import { usePagination } from '../../lib/use-pagination';
import { managerFallbackInterval, useManagerSseConnected } from './manager-sse-status';

export const INSTANCES_KEY = ['manager', 'instances'] as const;

export function instanceStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'active':
      return 'ok';
    case 'disabled':
    case 'removed_keep_data':
      return 'neutral';
    case 'broken':
      return 'error';
    default:
      return 'info';
  }
}

export interface InstancesListProps {
  client: ApiClient;
  onOpen: (instanceId: string) => void;
  /** Opens the create-instance dialog (rendered by the parent). */
  onCreate: () => void;
}

export function InstancesList({ client, onOpen, onCreate }: InstancesListProps): JSX.Element {
  const sseConnected = useManagerSseConnected();
  const query = useQuery({
    queryKey: INSTANCES_KEY,
    queryFn: () => client.listInstances(),
    refetchInterval: managerFallbackInterval(sseConnected, 10_000),
  });

  const instances = query.data ?? [];
  const instancesPage = usePagination(instances, 25);

  return (
    <Card
      title="Instances"
      description="Every SelfHelp instance on this server (inventory state — containers are not polled). Open an instance to run an on-demand health check, manage backups and updates, and read operation logs."
      aside={
        <Group gap="sm">
          <Button variant="ghost" loading={query.isFetching} onClick={() => void query.refetch()}>
            Refresh
          </Button>
          <Button variant="primary" onClick={onCreate}>
            New instance
          </Button>
        </Group>
      }
    >
      <Stack gap="md">
        <Alert tone="info" title="Keep this console private">
          This page can create, change and delete live instances. Reach it through an SSH tunnel only
          (<code>ssh -L 8800:127.0.0.1:8800 operator@server</code>) — never expose the manager port publicly.
        </Alert>

        {query.isPending ? (
          <Group justify="center" py="lg">
            <Spinner label="Loading instances" />
          </Group>
        ) : query.isError ? (
          <Alert tone="error" title="Could not load instances">
            {query.error instanceof ApiError ? query.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : instances.length === 0 ? (
          <EmptyState icon="📦" title="No instances yet">
            Create the first instance with the button above, or on the server CLI:{' '}
            <code>sh-manager instance install</code>.
          </EmptyState>
        ) : (
          <Table.ScrollContainer minWidth={760}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Instance</Table.Th>
                  <Table.Th>Domain</Table.Th>
                  <Table.Th>Mode</Table.Th>
                  <Table.Th>Version</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th aria-label="Actions" />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {instancesPage.pageItems.map((inst) => (
                  <Table.Tr key={inst.instanceId}>
                    <Table.Td>
                      <Anchor component="button" type="button" onClick={() => onOpen(inst.instanceId)} fw={600}>
                        {inst.instanceId}
                      </Anchor>
                      {inst.displayName ? (
                        <Text size="xs" c="dimmed">
                          {inst.displayName}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      {inst.domain ? (
                        <Anchor href={inst.domain.startsWith('http') ? inst.domain : `http://${inst.domain}`} target="_blank" rel="noopener noreferrer" size="sm">
                          {inst.domain}
                        </Anchor>
                      ) : (
                        <Text size="sm">—</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{inst.mode ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{inst.version ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        {inst.status === 'broken' && inst.brokenReason ? (
                          <Tooltip label={inst.brokenReason} multiline maw={360}>
                            <span>
                              <StatusBadge tone="error">broken</StatusBadge>
                            </span>
                          </Tooltip>
                        ) : (
                          <StatusBadge tone={instanceStatusTone(inst.status)}>{inst.status}</StatusBadge>
                        )}
                        {inst.busy ? <StatusBadge tone="info">busy</StatusBadge> : null}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Button variant="ghost" onClick={() => onOpen(inst.instanceId)}>
                        Open
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <PaginationFooter
              page={instancesPage.page}
              pageCount={instancesPage.pageCount}
              onPageChange={instancesPage.setPage}
              total={instancesPage.total}
              range={instancesPage.range}
              noun="instances"
            />
          </Table.ScrollContainer>
        )}
      </Stack>
    </Card>
  );
}

/** Summary lookup used by the detail screen to avoid a duplicate fetch. */
export function findInstance(list: InstanceSummary[] | undefined, instanceId: string): InstanceSummary | null {
  return list?.find((i) => i.instanceId === instanceId) ?? null;
}
