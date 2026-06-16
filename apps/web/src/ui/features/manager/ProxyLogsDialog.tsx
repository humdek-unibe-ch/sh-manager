// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * View the shared Traefik reverse-proxy's recent logs from the manager.
 *
 * The proxy is the single edge in front of EVERY instance: it terminates TLS
 * (Let's Encrypt), and routes each hostname to the right backend container. When
 * a domain answers "404 page not found", or HTTPS never gets a certificate, the
 * reason is almost always here — the Docker provider failing to discover
 * containers, an ACME challenge being refused, or the proxy not running at all.
 * Surfacing these logs in the GUI means an operator can diagnose the edge
 * without SSHing in and remembering `docker compose logs` paths.
 *
 * The BFF reads them via `docker compose logs` and REDACTS secret-looking
 * content before they reach the browser.
 */
import { useMemo, useState } from 'react';
import { Code, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Dialog, SelectField, Spinner, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';

export interface ProxyLogsDialogProps {
  client: ApiClient;
  opened: boolean;
  onClose: () => void;
}

const TAIL_OPTIONS = [
  { value: '100', label: 'Last 100 lines' },
  { value: '200', label: 'Last 200 lines' },
  { value: '500', label: 'Last 500 lines' },
  { value: '1000', label: 'Last 1000 lines' },
  { value: '2000', label: 'Last 2000 lines' },
];

/**
 * Quick filters for the questions operators actually ask of the edge proxy:
 * "did TLS issue?" (acme), "why the 404?" (router/rule/provider), "is it
 * erroring?" (error/warn). Empty = show everything.
 */
const QUICK_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All lines' },
  { value: 'acme', label: 'TLS / certificates (acme)' },
  { value: 'error', label: 'Errors' },
  { value: 'router', label: 'Routing' },
];

export function ProxyLogsDialog({ client, opened, onClose }: ProxyLogsDialogProps): JSX.Element {
  const [tail, setTail] = useState(200);
  const [filter, setFilter] = useState('');

  const logs = useQuery({
    queryKey: ['manager', 'proxy', 'logs', tail],
    queryFn: () => client.getProxyLogs(tail),
    enabled: opened,
    refetchOnWindowFocus: false,
  });

  const text = logs.data?.text.trimEnd() ?? '';

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
      title="Reverse proxy logs — Traefik"
      size="xl"
      footer={footer}
      scrollBody={false}
    >
      <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
        <Group align="flex-end" gap="sm" grow>
          <SelectField
            label="Quick filter"
            value={QUICK_FILTERS.some((q) => q.value === filter) ? filter : ''}
            options={QUICK_FILTERS}
            onChange={setFilter}
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
          The shared Traefik proxy in front of every instance (TLS termination + hostname routing), with secrets
          redacted. Look here when a domain returns 404 or HTTPS has no certificate.
        </Text>

        {logs.isPending ? (
          <Group justify="center" py="xl">
            <Spinner label="Loading proxy logs" />
          </Group>
        ) : logs.isError ? (
          <Alert tone="error" title="Could not load proxy logs">
            {logs.error instanceof ApiError ? logs.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : text === '' ? (
          <Alert tone="info" title="No log output">
            The proxy has not written any log lines yet (it may not be running — start it with
            <Text span fw={500}>
              {' '}
              sh-manager server start
            </Text>
            ).
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
