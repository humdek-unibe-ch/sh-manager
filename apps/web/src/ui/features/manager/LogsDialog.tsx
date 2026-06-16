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
import { useMemo, useState } from 'react';
import { Code, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Dialog, SelectField, Spinner, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { LogService } from '../../lib/types';

export interface LogsDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  /**
   * Instance mode. `mailpit` only exists in the compose of local-mode instances
   * (the bundled test mailbox), so the picker hides it otherwise — selecting it
   * on a production instance would only ever yield "no such service: mailpit".
   */
  mode?: 'local' | 'production' | null;
}

/**
 * UI labels for the log-readable services. The server validates the requested
 * service against the authoritative `LOG_SERVICES`; this list only drives the
 * picker (kept here so the browser bundle never imports server-side code).
 *
 * `mailpit` is gated on local mode (see {@link LogsDialogProps.mode}).
 */
const SERVICE_OPTIONS: { value: LogService; label: string; localOnly?: boolean }[] = [
  { value: 'backend', label: 'Backend (Symfony)' },
  { value: 'frontend', label: 'Frontend (Next.js)' },
  { value: 'worker', label: 'Worker (messenger)' },
  { value: 'scheduler', label: 'Scheduler' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'redis', label: 'Redis' },
  { value: 'mercure', label: 'Mercure' },
  { value: 'mailpit', label: 'Mailpit (local test mailbox)', localOnly: true },
];

const TAIL_OPTIONS = [
  { value: '100', label: 'Last 100 lines' },
  { value: '200', label: 'Last 200 lines' },
  { value: '500', label: 'Last 500 lines' },
  { value: '1000', label: 'Last 1000 lines' },
  { value: '2000', label: 'Last 2000 lines' },
];

export function LogsDialog({ client, instanceId, opened, onClose, mode }: LogsDialogProps): JSX.Element {
  const [service, setService] = useState<LogService>('backend');
  const [tail, setTail] = useState(200);
  const [filter, setFilter] = useState('');

  // Hide local-only services (mailpit) for non-local instances so the picker
  // never offers a service the instance does not run.
  const serviceOptions = useMemo(
    () => SERVICE_OPTIONS.filter((o) => !o.localOnly || mode === 'local'),
    [mode],
  );

  const logs = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'logs', service, tail],
    queryFn: () => client.getInstanceLogs(instanceId, service, tail),
    enabled: opened,
    refetchOnWindowFocus: false,
  });

  const text = logs.data?.text.trimEnd() ?? '';

  // Client-side substring filter: keep only the lines that match what the
  // operator typed (case-insensitive). Trimmed so a stray space is not treated
  // as a filter. Memoised so re-renders (e.g. background refetch) do not rescan.
  const filterTerm = filter.trim().toLowerCase();
  const filteredText = useMemo(() => {
    if (filterTerm === '') return text;
    return text
      .split('\n')
      .filter((line) => line.toLowerCase().includes(filterTerm))
      .join('\n');
  }, [text, filterTerm]);

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
    <Dialog
      opened={opened}
      onClose={onClose}
      title={`Logs — ${instanceId}`}
      size="xl"
      footer={footer}
      scrollBody={false}
    >
      {/* Flex column that fills the (non-scrolling) dialog body: the controls +
          filter stay pinned at the top and ONLY the log region below scrolls —
          one scrollbar, never two. */}
      <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
        <Group align="flex-end" gap="sm" grow>
          <SelectField
            label="Service"
            value={service}
            options={serviceOptions}
            onChange={(v) => setService(v as LogService)}
          />
          <SelectField
            label="Lines"
            value={String(tail)}
            options={TAIL_OPTIONS}
            onChange={(v) => setTail(Number(v))}
          />
        </Group>

        <TextField
          label="Filter"
          placeholder="Filter log lines (substring match)…"
          value={filter}
          onChange={setFilter}
        />

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
        ) : filteredText === '' ? (
          <Alert tone="info" title="No matching lines">
            No log lines contain &ldquo;{filter.trim()}&rdquo;. Clear the filter to see all output.
          </Alert>
        ) : (
          <ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
            <Code block style={{ fontSize: 12, whiteSpace: 'pre' }}>
              {filteredText}
            </Code>
          </ScrollArea>
        )}
      </Stack>
    </Dialog>
  );
}
