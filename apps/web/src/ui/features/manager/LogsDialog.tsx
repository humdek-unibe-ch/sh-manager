// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * View an instance's recent container logs from the manager.
 *
 * Surfaces the running container's stdout/stderr (what Symfony on the backend and
 * Next.js on the frontend print on error) per service, on demand — so an operator
 * can diagnose an instance without SSHing into the server. The BFF reads the logs
 * via `docker compose logs` and REDACTS any secret-looking content before they
 * ever reach the browser.
 *
 * Persistence note (shown to the operator): these are the current container's
 * logs — they survive a restart but reset when the container is recreated (e.g.
 * by an update). For a portable point-in-time copy, take a support bundle before
 * a risky change.
 */
import { useState } from 'react';
import { Code, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Dialog, SelectField, Spinner } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { LogService } from '../../lib/types';

export interface LogsDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
}

/**
 * UI labels for the log-readable services. The server validates the requested
 * service against the authoritative `LOG_SERVICES`; this list only drives the
 * picker (kept here so the browser bundle never imports server-side code).
 */
const SERVICE_OPTIONS: { value: LogService; label: string }[] = [
  { value: 'backend', label: 'Backend (Symfony)' },
  { value: 'frontend', label: 'Frontend (Next.js)' },
  { value: 'worker', label: 'Worker (messenger)' },
  { value: 'scheduler', label: 'Scheduler' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'redis', label: 'Redis' },
  { value: 'mercure', label: 'Mercure' },
  { value: 'mailpit', label: 'Mailpit (local mode)' },
];

const TAIL_OPTIONS = [
  { value: '100', label: 'Last 100 lines' },
  { value: '200', label: 'Last 200 lines' },
  { value: '500', label: 'Last 500 lines' },
  { value: '1000', label: 'Last 1000 lines' },
  { value: '2000', label: 'Last 2000 lines' },
];

export function LogsDialog({ client, instanceId, opened, onClose }: LogsDialogProps): JSX.Element {
  const [service, setService] = useState<LogService>('backend');
  const [tail, setTail] = useState(200);

  const logs = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'logs', service, tail],
    queryFn: () => client.getInstanceLogs(instanceId, service, tail),
    enabled: opened,
    refetchOnWindowFocus: false,
  });

  const text = logs.data?.text.trimEnd() ?? '';

  const footer = (
    <Group justify="space-between" gap="sm">
      <Text size="xs" c="dimmed">
        {logs.data ? `Read ${new Date(logs.data.readAt).toLocaleTimeString()}` : ''}
      </Text>
      <Group gap="sm">
        <Button variant="secondary" loading={logs.isFetching} onClick={() => void logs.refetch()}>
          Refresh
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </Group>
    </Group>
  );

  return (
    <Dialog opened={opened} onClose={onClose} title={`Logs — ${instanceId}`} size="xl" footer={footer}>
      <Stack gap="md">
        <Group align="flex-end" gap="sm" grow>
          <SelectField
            label="Service"
            value={service}
            options={SERVICE_OPTIONS}
            onChange={(v) => setService(v as LogService)}
          />
          <SelectField
            label="Lines"
            value={String(tail)}
            options={TAIL_OPTIONS}
            onChange={(v) => setTail(Number(v))}
          />
        </Group>

        <Text size="xs" c="dimmed">
          The current container&apos;s output (errors included), with secrets redacted. These reset when
          the container is recreated by an update — take a support bundle for a portable copy.
        </Text>

        {logs.isPending ? (
          <Group justify="center" py="xl">
            <Spinner label="Loading logs" />
          </Group>
        ) : logs.isError ? (
          <Alert tone="error" title="Could not load logs">
            {logs.error instanceof ApiError ? logs.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : text === '' ? (
          <Alert tone="info" title="No log output">
            This service has not written any log lines yet (it may not be running).
          </Alert>
        ) : (
          <ScrollArea.Autosize mah={460} type="auto">
            <Code block style={{ fontSize: 12, whiteSpace: 'pre' }}>
              {text}
            </Code>
          </ScrollArea.Autosize>
        )}
      </Stack>
    </Dialog>
  );
}
