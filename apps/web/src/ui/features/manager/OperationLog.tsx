// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Live view of one journaled operation: phase, redacted log lines, result or
 * error. Polls the BFF every 2s while the operation is running, then stops —
 * the journal is the single source of truth, the browser only renders it.
 */
import { Box, Code, Group, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Alert, Spinner, StatusBadge, type BadgeTone } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { OperationStatus } from '../../lib/types';

export function operationTone(status: OperationStatus): BadgeTone {
  return status === 'succeeded' ? 'ok' : status === 'failed' ? 'error' : 'info';
}

export interface OperationLogProps {
  client: ApiClient;
  operationId: string;
}

export function OperationLog({ client, operationId }: OperationLogProps): JSX.Element {
  const query = useQuery({
    queryKey: ['manager', 'operation', operationId],
    queryFn: () => client.getOperation(operationId),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2_000 : false),
  });

  if (query.isPending) {
    return (
      <Group justify="center" py="md">
        <Spinner label="Loading operation" />
      </Group>
    );
  }
  if (query.isError) {
    return (
      <Alert tone="error" title="Could not load the operation">
        {query.error instanceof ApiError ? query.error.message : 'The manager service did not answer.'}
      </Alert>
    );
  }

  const op = query.data;
  return (
    <Stack gap="sm">
      <Group gap="sm" wrap="wrap">
        <StatusBadge tone={operationTone(op.status)}>{op.status}</StatusBadge>
        <Text size="sm" fw={500}>
          {op.kind}
        </Text>
        {op.phase ? (
          <Text size="sm" c="dimmed">
            phase: {op.phase}
          </Text>
        ) : null}
        <Text size="xs" c="dimmed">
          started {new Date(op.startedAt).toLocaleString()}
          {op.finishedAt ? ` — finished ${new Date(op.finishedAt).toLocaleString()}` : ''}
        </Text>
      </Group>

      {op.log.length > 0 ? (
        <Box
          component="pre"
          aria-label="Operation log"
          style={{
            margin: 0,
            maxHeight: 280,
            overflow: 'auto',
            fontSize: 12,
            lineHeight: 1.5,
            background: 'var(--mantine-color-dark-8, #1a1b1e)',
            color: 'var(--mantine-color-gray-3, #dee2e6)',
            borderRadius: 8,
            padding: 12,
            whiteSpace: 'pre-wrap',
          }}
        >
          {op.log.join('\n')}
        </Box>
      ) : (
        <Text size="sm" c="dimmed">
          No log lines yet.
        </Text>
      )}

      {op.status === 'failed' && op.error ? (
        <Alert tone="error" title="Operation failed">
          {op.error}
        </Alert>
      ) : null}
      {op.status === 'succeeded' && op.result !== null && op.result !== undefined ? (
        <Code block style={{ maxHeight: 200, overflow: 'auto' }}>
          {JSON.stringify(op.result, null, 2)}
        </Code>
      ) : null}
    </Stack>
  );
}
