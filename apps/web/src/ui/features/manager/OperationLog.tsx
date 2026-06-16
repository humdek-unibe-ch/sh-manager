// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Live view of one journaled operation: phase, redacted log lines, result or
 * error. Polls the BFF every 2s while the operation is running, then stops —
 * the journal is the single source of truth, the browser only renders it.
 */
import { useState } from 'react';
import { Box, Code, CopyButton, Group, Stack, Switch, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Spinner, StatusBadge, StepProgress, type BadgeTone } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { OperationStatus } from '../../lib/types';
import { buildOperationSteps, operationKindLabel } from '../../lib/operation-steps';
import { useManagerSseConnected } from './manager-sse-status';

export function operationTone(status: OperationStatus): BadgeTone {
  return status === 'succeeded' ? 'ok' : status === 'failed' ? 'error' : 'info';
}

/**
 * Heuristic: does a journal line report a problem (so it survives the "errors
 * only" filter)? The journal is plain redacted text, so we match the vocabulary
 * the operation bodies actually emit — `: failed`, `warning:`, `rejected`,
 * rollback, interrupted, unhealthy, etc.
 */
const PROBLEM_RE = /(:\s*failed\b|\bfailed\b|\berror\b|\bexception\b|\bfatal\b|\brejected\b|\bdenied\b|\binterrupted\b|\bunhealthy\b|\broll(?:ed|back)\b|\bwarning\b)/i;

export function isProblemLogLine(line: string): boolean {
  return PROBLEM_RE.test(line);
}

export interface OperationLogProps {
  client: ApiClient;
  operationId: string;
  /**
   * Render the per-kind step checklist above the log (default `true`). The
   * create wizard sets this `false` because it shows its own richer install
   * checklist alongside, so we avoid a duplicate.
   */
  showSteps?: boolean;
}

export function OperationLog({ client, operationId, showSteps = true }: OperationLogProps): JSX.Element {
  const [errorsOnly, setErrorsOnly] = useState(false);
  // The `/api/events` stream pushes a frame per log line, so the live log stays
  // current without polling; the 2s poll is a fallback for a dropped stream.
  const sseConnected = useManagerSseConnected();
  const query = useQuery({
    queryKey: ['manager', 'operation', operationId],
    queryFn: () => client.getOperation(operationId),
    refetchInterval: (q) => (!sseConnected && q.state.data?.status === 'running' ? 2_000 : false),
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
  const steps = showSteps ? buildOperationSteps({ kind: op.kind, phase: op.phase, status: op.status }) : [];
  const problemCount = op.log.filter(isProblemLogLine).length;
  const shownLog = errorsOnly ? op.log.filter(isProblemLogLine) : op.log;
  // The copy button always copies the FULL log (a redacted support paste),
  // regardless of the on-screen "errors only" filter.
  const copyText = op.log.join('\n');
  return (
    <Stack gap="sm">
      <Group gap="sm" wrap="wrap">
        <StatusBadge tone={operationTone(op.status)}>{op.status}</StatusBadge>
        <Text size="sm" fw={500}>
          {operationKindLabel(op.kind)}
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

      {steps.length > 0 ? <StepProgress steps={steps} /> : null}

      <Group justify="space-between" align="center" gap="sm" wrap="wrap">
        <Group gap="sm" align="center">
          <Text size="xs" c="dimmed">
            {op.log.length} line{op.log.length === 1 ? '' : 's'}
            {problemCount > 0 ? ` · ${problemCount} with issues` : ''}
          </Text>
          <Switch
            size="xs"
            label="Errors only"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.currentTarget.checked)}
            disabled={op.log.length === 0}
          />
        </Group>
        <CopyButton value={copyText} timeout={1600}>
          {({ copied, copy }) => (
            <Button variant="ghost" onClick={copy} disabled={op.log.length === 0} aria-label="Copy operation log">
              {copied ? 'Copied' : 'Copy log'}
            </Button>
          )}
        </CopyButton>
      </Group>

      {op.log.length > 0 ? (
        shownLog.length > 0 ? (
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
            {shownLog.join('\n')}
          </Box>
        ) : (
          <Text size="sm" c="dimmed">
            No problem lines — the whole log is clean. Turn off “Errors only” to see all {op.log.length} lines.
          </Text>
        )
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
