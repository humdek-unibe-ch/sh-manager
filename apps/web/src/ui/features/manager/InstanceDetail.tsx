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
import { Anchor, Code, Group, Modal, Stack, Table, Text, Title } from '@mantine/core';
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
import { operationKindLabel } from '../../lib/operation-steps';
import { RemoveInstanceDialog } from './RemoveInstanceDialog';
import { ToggleEnabledDialog } from './ToggleEnabledDialog';
import { RenameInstanceDialog } from './RenameInstanceDialog';
import { SetAddressDialog } from './SetAddressDialog';
import { INSTANCES_KEY, instanceStatusTone } from './InstancesList';
import { managerFallbackInterval, useManagerSseConnected } from './manager-sse-status';

type DialogKind =
  | 'update'
  | 'clone'
  | 'rename'
  | 'address'
  | 'mailer'
  | 'env'
  | 'logs'
  | 'disable'
  | 'enable'
  | 'remove'
  | null;

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
  /** Operation opened from the history table for a full detail view (modal). */
  const [detailOperationId, setDetailOperationId] = useState<string | null>(null);
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
    // …the live plugins (separate key, so refresh it explicitly)…
    void queryClient.invalidateQueries({ queryKey: ['manager', 'plugins', instanceId] });
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
    // A finished operation may have changed the installed plugins (install/
    // uninstall/purge/update) — refresh the live list too.
    void queryClient.invalidateQueries({ queryKey: ['manager', 'plugins', instanceId] });
    // Refresh the left-hand list too: a finished rename/update/address change is
    // visible there (name, version, status), not just on this detail page.
    void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
    const label = operationKindLabel(op.kind);
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

  // Check for core update availability using dry-run (non-blocking, no user input)
  const coreUpdateCheck = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'core-update-check'],
    queryFn: () => client.updateDryRun(instanceId, {}),
    refetchInterval: managerFallbackInterval(sseConnected, 300_000), // Check every 5 minutes
    retry: false,
  });

  // Check for frontend-only update availability
  const frontendUpdateCheck = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'frontend-update-check'],
    queryFn: () => client.frontendUpdateDryRun(instanceId, {}),
    refetchInterval: managerFallbackInterval(sseConnected, 300_000),
    retry: false,
  });

  // Live installed plugins, read from the running instance's DB (the source of
  // truth; the manifest's list lags CMS-driven installs). Kept on a SEPARATE
  // key (not the instance prefix) so the chatty SSE log invalidations don't
  // re-exec this heavier docker query on every line; it refreshes on mount, on
  // manual refresh, and when an operation finishes (see below).
  const pluginsQuery = useQuery({
    queryKey: ['manager', 'plugins', instanceId],
    queryFn: () => client.listInstancePlugins(instanceId),
    staleTime: 30_000,
    retry: false,
  });

  const detail = detailQuery.data ?? null;
  const summary = detail?.summary ?? null;
  const busy = summary?.busy != null;
  const operations = operationsQuery.data ?? [];
  const operationsPage = usePagination(operations, 25);
  const manifest = detail?.manifest ?? null;

  // Prefer the LIVE plugin read (the instance's own `plugins` table) over the
  // manifest's recorded list, which lags CMS-driven installs (so the UI showed
  // "no plugins" even with plugins installed). When the instance is down the
  // live read is null → fall back to the manifest (versions only, no enabled
  // state, since that is all the manifest records).
  const livePlugins = pluginsQuery.data;
  const pluginsAreLive = Array.isArray(livePlugins);
  const pluginRows: { id: string; version: string; enabled: boolean | null }[] = pluginsAreLive
    ? livePlugins.map((p) => ({ id: p.id, version: p.version, enabled: p.enabled }))
    : (manifest?.installedPlugins ?? []).map((p) => ({ id: p.id, version: p.version, enabled: null }));
  const pluginsPage = usePagination(pluginRows, 25);

  // Extract update availability + the resolved latest target from the dry-run
  // responses. A core update moves backend/scheduler/worker together (they share
  // the SelfHelp version), so they all report the same "latest".
  const corePlan = coreUpdateCheck.data?.plan as { status: string; targetVersion?: string } | null;
  const coreUpdateAvailable: boolean = corePlan?.status === 'ok' && !!corePlan.targetVersion && corePlan.targetVersion !== manifest?.versions.selfhelp;
  const frontendPlan = frontendUpdateCheck.data?.plan as { status: string; targetFrontendVersion?: string } | null;
  const frontendUpdateAvailable: boolean = frontendPlan?.status === 'ok' && !!frontendPlan.targetFrontendVersion && frontendPlan.targetFrontendVersion !== manifest?.versions.frontend;

  // The latest version available for a component: the dry-run's target when an
  // update is offered, otherwise the current version when the registry confirms
  // we are up to date, otherwise null (the check is still loading or failed, so
  // we honestly show "—" rather than implying "no update").
  const coreLatest: string | null = corePlan
    ? coreUpdateAvailable
      ? corePlan.targetVersion ?? null
      : corePlan.status === 'up_to_date'
        ? manifest?.versions.selfhelp ?? null
        : null
    : null;
  const frontendLatest: string | null = frontendPlan
    ? frontendUpdateAvailable
      ? frontendPlan.targetFrontendVersion ?? null
      : frontendPlan.status === 'up_to_date'
        ? manifest?.versions.frontend ?? null
        : null
    : null;

  const anyUpdateAvailable = coreUpdateAvailable || frontendUpdateAvailable;

  // One row per managed container, pairing the recorded version (where the
  // manifest tracks one) with the resolved image tag/digest, the latest version
  // available, and whether an update is offered.
  const componentRows: {
    label: string;
    version: string | null;
    image: string | null;
    latest?: string | null;
    updateAvailable?: boolean;
  }[] = manifest
    ? [
        { label: 'SelfHelp', version: manifest.versions.selfhelp, image: null, latest: coreLatest, updateAvailable: coreUpdateAvailable },
        { label: 'Backend', version: manifest.versions.backend, image: manifest.images.backend, latest: coreLatest, updateAvailable: coreUpdateAvailable },
        { label: 'Frontend', version: manifest.versions.frontend, image: manifest.images.frontend, latest: frontendLatest, updateAvailable: frontendUpdateAvailable },
        { label: 'Scheduler', version: manifest.versions.scheduler, image: manifest.images.scheduler, latest: coreLatest, updateAvailable: coreUpdateAvailable },
        { label: 'Worker', version: manifest.versions.worker, image: manifest.images.worker, latest: coreLatest, updateAvailable: coreUpdateAvailable },
        { label: 'Plugin API', version: manifest.versions.pluginApi, image: null },
        { label: 'MySQL', version: null, image: manifest.images.mysql },
        { label: 'Redis', version: null, image: manifest.images.redis },
        { label: 'Mercure', version: null, image: manifest.images.mercure },
        // Mailpit is the bundled local test mailbox (axllent/mailpit:latest);
        // it only runs in local mode and is not version-pinned in the manifest.
        ...(summary?.mode === 'local'
          ? [{ label: 'Mailpit', version: null, image: 'axllent/mailpit:latest' }]
          : []),
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
          {/* Lifecycle toggle: a disabled/stopped instance can be brought back
              online (Enable); a running one can be quiesced (Disable, reversible). */}
          {summary.status === 'disabled' || summary.status === 'removed_keep_data' ? (
            <Button variant="primary" disabled={busy} onClick={() => setDialog('enable')}>
              Enable
            </Button>
          ) : summary.status === 'active' ? (
            <Button variant="secondary" disabled={busy} onClick={() => setDialog('disable')}>
              Disable…
            </Button>
          ) : null}
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
          description="Versions and container image tags recorded in this instance's manifest, with the latest version available from the registry."
          aside={
            anyUpdateAvailable ? (
              <StatusBadge tone="warning">Updates available</StatusBadge>
            ) : coreUpdateCheck.isFetched && corePlan?.status === 'up_to_date' ? (
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
      ) : null}

      {manifest ? (
        <Card
          title="Installed plugins"
          description={
            pluginsQuery.isLoading
              ? 'Reading plugins from the running instance…'
              : pluginsAreLive
                ? pluginRows.length === 1
                  ? '1 plugin installed (read live from the instance).'
                  : `${pluginRows.length} plugins installed (read live from the instance).`
                : 'Instance unreachable — showing the plugins recorded in the manifest.'
          }
        >
          {pluginRows.length === 0 ? (
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
                    {pluginsAreLive ? <Table.Th>Status</Table.Th> : null}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {pluginsPage.pageItems.map((plugin) => (
                    <Table.Tr key={plugin.id}>
                      <Table.Td>
                        <Text size="sm">{plugin.id}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Code>{plugin.version}</Code>
                      </Table.Td>
                      {pluginsAreLive ? (
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
                page={pluginsPage.page}
                pageCount={pluginsPage.pageCount}
                onPageChange={pluginsPage.setPage}
                total={pluginsPage.total}
                range={pluginsPage.range}
                noun="plugins"
              />
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
                      <Anchor component="button" type="button" size="sm" onClick={() => setDetailOperationId(op.id)}>
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
        mode={summary.mode === 'local' ? 'local' : summary.mode === 'production' ? 'production' : null}
        opened={dialog === 'logs'}
        onClose={() => setDialog(null)}
      />
      <ToggleEnabledDialog
        client={client}
        instanceId={instanceId}
        action={dialog === 'disable' ? 'disable' : dialog === 'enable' ? 'enable' : null}
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

      <Modal
        opened={detailOperationId !== null}
        onClose={() => setDetailOperationId(null)}
        title="Operation detail"
        size="xl"
        centered
      >
        {detailOperationId ? <OperationLog client={client} operationId={detailOperationId} /> : null}
      </Modal>
    </Stack>
  );
}
