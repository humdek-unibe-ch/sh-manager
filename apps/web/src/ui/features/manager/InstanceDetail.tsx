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
import { Anchor, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { Alert, Button, Card, KeyValue, Spinner, StatusBadge } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { BackupManager } from './BackupManager';
import { CloneInstanceDialog } from './CloneInstanceDialog';
import { EnvDialog } from './EnvDialog';
import { LogsDialog } from './LogsDialog';
import { UpdateDialog } from './UpdateDialog';
import { MailerDialog } from './MailerDialog';
import { OperationLog } from './OperationLog';
import { RemoveInstanceDialog } from './RemoveInstanceDialog';
import { ToggleEnabledDialog } from './ToggleEnabledDialog';
import { SafeModeDialog } from './SafeModeDialog';
import { PluginRecoverDialog } from './PluginRecoverDialog';
import { RenameInstanceDialog } from './RenameInstanceDialog';
import { SetAddressDialog } from './SetAddressDialog';
import { instanceStatusTone } from './InstancesList';
import { useInstanceDetail } from './use-instance-detail';
import { ComponentsCard, HealthSection, OperationHistoryCard, PluginsCard } from './instance-detail-sections';

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
  | 'safe-mode'
  | 'plugin-recover'
  | 'remove'
  | null;

export interface InstanceDetailProps {
  client: ApiClient;
  instanceId: string;
}

export function InstanceDetail({ client, instanceId }: InstanceDetailProps): JSX.Element {
  const [dialog, setDialog] = useState<DialogKind>(null);
  /** Operation opened from the history table for a full detail view (modal). */
  const [detailOperationId, setDetailOperationId] = useState<string | null>(null);

  const {
    detailQuery,
    operationsQuery,
    coreUpdateCheck,
    pluginsQuery,
    health,
    watchedOperationId,
    setWatchedOperationId,
    refreshInstance,
    onStarted,
    detail,
    summary,
    busy,
    operations,
    operationsPage,
    manifest,
    pluginsAreLive,
    pluginRows,
    pluginsPage,
    corePlan,
    hasMobilePreview,
    anyUpdateAvailable,
    componentRows,
  } = useInstanceDetail(client, instanceId);

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
          {/* Recovery actions: toggle safe mode (plugins off) and finalize a
              half-removed plugin that crash-loops the backend. Safe mode works
              even when the backend is unbootable, so it is never disabled. */}
          <Button variant="secondary" onClick={() => setDialog('safe-mode')}>
            Safe mode…
          </Button>
          <Button variant="secondary" onClick={() => setDialog('plugin-recover')}>
            Plugin recover…
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
        <ComponentsCard
          componentRows={componentRows}
          anyUpdateAvailable={anyUpdateAvailable}
          upToDate={coreUpdateCheck.isFetched && corePlan?.status === 'up_to_date'}
        />
      ) : null}

      {manifest ? (
        <PluginsCard loading={pluginsQuery.isLoading} areLive={pluginsAreLive} rows={pluginRows} page={pluginsPage} />
      ) : null}

      <HealthSection isError={health.isError} error={health.error} data={health.data} />

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

      <OperationHistoryCard
        isPending={operationsQuery.isPending}
        isFetching={operationsQuery.isFetching}
        operations={operations}
        page={operationsPage}
        onRefresh={refreshInstance}
        onOpenOperation={setDetailOperationId}
      />

      <UpdateDialog
        client={client}
        instanceId={instanceId}
        opened={dialog === 'update'}
        onClose={() => setDialog(null)}
        onStarted={onStarted}
        mobilePreviewAvailable={hasMobilePreview}
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
      <SafeModeDialog
        client={client}
        instanceId={instanceId}
        opened={dialog === 'safe-mode'}
        onClose={() => setDialog(null)}
        onStarted={onStarted}
      />
      <PluginRecoverDialog
        client={client}
        instanceId={instanceId}
        opened={dialog === 'plugin-recover'}
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
