// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Authenticated operations console (persistent mode).
 *
 * Two views, no client router: the overview (environment checks, manager
 * version, instances list) and the per-instance detail page (health, backups,
 * update with dry-run, clone, remove, live operation logs). All instance
 * mutations run through the BFF job layer and are watched via the operation
 * journal — the GUI shows real logs, never imagined state.
 */
import { useMemo, useState } from 'react';
import { Anchor, Center, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CheckRow,
  CommandPreview,
  Spinner,
  StatusBadge,
  type BadgeTone,
  type CheckStatus,
} from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { CHECK_META } from '../../lib/wizard-view';
import type { CheckResult, Snapshot, WizardStepId } from '../../lib/types';
import { CreateInstanceForm } from './CreateInstanceForm';
import { InstanceDetail } from './InstanceDetail';
import { InstancesList, INSTANCES_KEY } from './InstancesList';
import { OperationLog } from './OperationLog';

const CHECKS: WizardStepId[] = ['docker', 'internet', 'registry', 'resources'];
const STATE_KEY = ['manager', 'console', 'state'] as const;
const UPDATE_KEY = ['manager', 'console', 'update-check'] as const;

/**
 * CLI-only tools that have no GUI equivalent (everything lifecycle-related now
 * lives on the instance pages). Command names match `sh-manager --help`.
 */
const CLI_TOOLS: { label: string; command: string }[] = [
  { label: 'Generate a support bundle', command: 'sh-manager instance support-bundle <instance-id>' },
  { label: 'Host resource preflight', command: 'sh-manager doctor' },
];

function checkStatus(result: CheckResult | undefined, running: boolean): CheckStatus {
  if (running) return 'running';
  if (!result) return 'pending';
  if (result.severity === 'error' || !result.ok) return 'error';
  if (result.severity === 'warning') return 'warning';
  return 'ok';
}

function friendly(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export interface OperationsConsoleProps {
  client: ApiClient;
}

export function OperationsConsole({ client }: OperationsConsoleProps): JSX.Element {
  const queryClient = useQueryClient();
  const [openInstanceId, setOpenInstanceId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  /** Operation started from the overview (instance create) — watched inline. */
  const [watchedOperationId, setWatchedOperationId] = useState<string | null>(null);

  const stateQuery = useQuery({ queryKey: STATE_KEY, queryFn: () => client.getState() });
  const snapshot = stateQuery.data ?? null;
  // Non-blocking: the console renders fully even when the release feed is slow
  // or unreachable (the card then shows the error detail).
  const updateQuery = useQuery({ queryKey: UPDATE_KEY, queryFn: () => client.managerUpdateCheck(), retry: false });
  const update = updateQuery.data ?? null;

  const runCheck = useMutation({
    mutationFn: (step: WizardStepId) => client.runCheck(step),
    onSuccess: (snap: Snapshot) => queryClient.setQueryData(STATE_KEY, snap),
  });
  const runningStep = runCheck.isPending ? (runCheck.variables ?? null) : null;

  const error = stateQuery.isError
    ? friendly(stateQuery.error, 'Could not load server status.')
    : runCheck.isError
      ? friendly(runCheck.error, 'That check could not run.')
      : null;

  const overall = useMemo<{ tone: BadgeTone; label: string }>(() => {
    if (!snapshot) return { tone: 'pending', label: 'Unknown' };
    const results = CHECKS.map((c) => snapshot.checks[c]).filter(Boolean) as CheckResult[];
    if (results.length === 0) return { tone: 'pending', label: 'Not checked yet' };
    if (results.some((r) => r.severity === 'error' || !r.ok)) return { tone: 'error', label: 'Needs attention' };
    if (results.some((r) => r.severity === 'warning')) return { tone: 'warning', label: 'Degraded' };
    return { tone: 'ok', label: 'Healthy' };
  }, [snapshot]);

  if (stateQuery.isPending) {
    return (
      <Center mih="40vh">
        <Spinner size="lg" />
      </Center>
    );
  }

  if (openInstanceId) {
    return <InstanceDetail client={client} instanceId={openInstanceId} onBack={() => setOpenInstanceId(null)} />;
  }

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Title order={2}>Server operations</Title>
          <Text c="dimmed">Live status of this SelfHelp server and the operator actions available to you.</Text>
        </div>
        <Group gap="sm">
          <StatusBadge tone={overall.tone}>{overall.label}</StatusBadge>
          <Button
            variant="secondary"
            loading={runCheck.isPending}
            onClick={() => {
              void (async () => {
                for (const c of CHECKS) await runCheck.mutateAsync(c).catch(() => undefined);
              })();
            }}
          >
            Run all checks
          </Button>
        </Group>
      </Group>

      {error ? (
        <Alert tone="error" title="Something went wrong">
          {error}
        </Alert>
      ) : null}

      <InstancesList client={client} onOpen={setOpenInstanceId} onCreate={() => setCreateOpen(true)} />

      {watchedOperationId ? (
        <Card
          title="Instance creation in progress"
          description="The new instance appears in the list above as soon as the install finishes."
          aside={
            <Button variant="ghost" onClick={() => setWatchedOperationId(null)}>
              Hide
            </Button>
          }
        >
          <OperationLog client={client} operationId={watchedOperationId} />
        </Card>
      ) : null}

      <Card title="Environment status" description="Re-run any check to refresh its status.">
        <Stack gap="md">
          {CHECKS.map((c) => {
            const meta = CHECK_META[c];
            const result = snapshot?.checks[c];
            const status = checkStatus(result, runningStep === c);
            return (
              <Group key={c} gap="sm" align="stretch" wrap="nowrap">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <CheckRow
                    status={status}
                    title={meta?.title ?? c}
                    description={meta?.description ?? ''}
                    detail={result?.detail}
                    fix={meta?.fix}
                  />
                </div>
                <Button
                  variant="ghost"
                  loading={runningStep === c}
                  onClick={() => void runCheck.mutate(c)}
                  aria-label={`Run ${meta?.title ?? c} check`}
                >
                  Run
                </Button>
              </Group>
            );
          })}
        </Stack>
      </Card>

      <Card
        title="Manager version"
        description="The manager checks the official GitHub releases for newer versions."
        aside={
          update ? (
            <StatusBadge tone={update.error ? 'neutral' : update.updateAvailable ? 'warning' : 'ok'}>
              {update.error ? 'Unknown' : update.updateAvailable ? `Update available: ${update.latestVersion}` : 'Up to date'}
            </StatusBadge>
          ) : (
            <StatusBadge tone="pending">{updateQuery.isError ? 'Unavailable' : 'Checking…'}</StatusBadge>
          )
        }
      >
        <Stack gap="sm">
          <Group gap="xs">
            <Text size="sm" fw={500}>
              Installed:
            </Text>
            <Text size="sm">{update ? `sh-manager ${update.currentVersion} (${update.runtime === 'docker' ? 'Docker image' : 'source checkout'})` : '…'}</Text>
          </Group>
          {update?.error ? (
            <Text size="sm" c="dimmed">
              Could not reach the release feed: {update.error}
            </Text>
          ) : null}
          {update?.updateAvailable ? (
            <>
              {update.releaseUrl ? (
                <Anchor href={update.releaseUrl} target="_blank" rel="noreferrer" size="sm">
                  Release notes for {update.latestVersion}
                </Anchor>
              ) : null}
              <Text size="sm" fw={500}>
                To update, run on the server:
              </Text>
              {update.instructions.map((cmd) =>
                cmd.startsWith('sh-manager ') || cmd.startsWith('docker ') || cmd.startsWith('git ') || cmd.startsWith('npm ') ? (
                  <CommandPreview key={cmd} value={cmd} label="Update command" />
                ) : (
                  <Text key={cmd} size="sm" c="dimmed">
                    {cmd}
                  </Text>
                ),
              )}
            </>
          ) : null}
          <Group>
            <Button variant="ghost" loading={updateQuery.isFetching} onClick={() => void updateQuery.refetch()}>
              Check for updates
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card
        title="Server CLI tools"
        description="Diagnostics that stay on the command line. Wrapper users: replace sh-manager with ./shm.ps1 (Windows) or ./shm.sh (Linux/macOS)."
      >
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {CLI_TOOLS.map((c) => (
            <Stack key={c.label} gap={6}>
              <Text size="sm" fw={500}>
                {c.label}
              </Text>
              <CommandPreview value={c.command} label={c.label} />
            </Stack>
          ))}
        </SimpleGrid>
      </Card>

      <CreateInstanceForm
        client={client}
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultRegistryUrl={snapshot?.config.registryUrl ?? ''}
        onStarted={(operationId) => {
          setWatchedOperationId(operationId);
          // The new instance shows up in the inventory as the install
          // progresses; refresh the list immediately and let its regular
          // polling pick up later state changes.
          void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
        }}
      />
    </Stack>
  );
}
