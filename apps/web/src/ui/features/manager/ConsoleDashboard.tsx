// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Dashboard view of the operations console: environment health, the instance
 * inventory, the manager's own version and the CLI-only diagnostics.
 *
 * Environment checks RUN AUTOMATICALLY when the dashboard loads (once per
 * mount, sequentially) so the operator sees real statuses instead of a wall
 * of "Pending" — re-running any check stays one click away.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Anchor, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CheckRow,
  CommandPreview,
  MetricCard,
  StatusBadge,
  type BadgeTone,
  type CheckStatus,
} from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { CHECK_META } from '../../lib/wizard-view';
import type { CheckResult, InstanceSummary, PreflightResult } from '../../lib/types';
import { InstancesList } from './InstancesList';
import { OperationLog } from './OperationLog';

const CHECKS = ['docker', 'internet', 'registry', 'resources'] as const;
export const CONSOLE_STATE_KEY = ['manager', 'console', 'state'] as const;
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

export interface ConsoleDashboardProps {
  client: ApiClient;
  instances: InstanceSummary[];
  onOpenInstance: (instanceId: string) => void;
  onCreate: () => void;
  /** Operation started from the console (instance create) — watched inline. */
  watchedOperationId: string | null;
  onHideWatched: () => void;
}

export function ConsoleDashboard({
  client,
  instances,
  onOpenInstance,
  onCreate,
  watchedOperationId,
  onHideWatched,
}: ConsoleDashboardProps): JSX.Element {
  // Non-blocking: the dashboard renders fully even when the release feed is
  // slow or unreachable (the card then shows the error detail).
  const updateQuery = useQuery({ queryKey: UPDATE_KEY, queryFn: () => client.managerUpdateCheck(), retry: false });
  const update = updateQuery.data ?? null;

  // Stateless preflight: one POST runs docker/internet/registry/resources.
  const preflight = useMutation({ mutationFn: () => client.runPreflight({}) });
  const checks: PreflightResult | null = preflight.data ?? null;
  const preflightMutate = preflight.mutate;

  // Auto-run once per mount so the operator sees real statuses, not "Pending".
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    preflightMutate();
  }, [preflightMutate]);

  const error = preflight.isError ? friendly(preflight.error, 'The environment checks could not run.') : null;

  const overall = useMemo<{ tone: BadgeTone; label: string }>(() => {
    if (preflight.isPending || !checks) return { tone: 'pending', label: 'Checking…' };
    const results = CHECKS.map((c) => checks[c]).filter(Boolean) as CheckResult[];
    if (results.length === 0) return { tone: 'pending', label: 'Unknown' };
    if (results.some((r) => r.severity === 'error' || !r.ok)) return { tone: 'error', label: 'Needs attention' };
    if (results.some((r) => r.severity === 'warning')) return { tone: 'warning', label: 'Degraded' };
    return { tone: 'ok', label: 'Healthy' };
  }, [checks, preflight.isPending]);

  const activeCount = instances.filter((i) => i.status === 'active').length;
  const brokenCount = instances.filter((i) => i.status === 'broken').length;

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Title order={2}>Server operations</Title>
          <Text c="dimmed">Live status of this SelfHelp server and the operator actions available to you.</Text>
        </div>
        <Group gap="sm">
          <StatusBadge tone={overall.tone}>{overall.label}</StatusBadge>
          <Button variant="secondary" loading={preflight.isPending} onClick={() => preflight.mutate()}>
            Run all checks
          </Button>
        </Group>
      </Group>

      {error ? (
        <Alert tone="error" title="Something went wrong">
          {error}
        </Alert>
      ) : null}

      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <MetricCard
          label="Instances"
          value={`${activeCount} active${brokenCount > 0 ? ` · ${brokenCount} broken` : ''}`}
          hint={`${instances.length} total on this server`}
          status={brokenCount > 0 ? 'warning' : 'ok'}
        />
        <MetricCard
          label="Environment"
          value={overall.label}
          hint="Docker, internet, registry & resources"
          status={overall.tone === 'ok' ? 'ok' : overall.tone === 'error' ? 'blocked' : overall.tone === 'warning' ? 'warning' : 'neutral'}
        />
        <MetricCard
          label="Manager"
          value={update ? `v${update.currentVersion}` : '…'}
          hint={
            update?.updateAvailable
              ? `Update available: ${update.latestVersion}`
              : update
                ? 'Up to date'
                : 'Checking the release feed…'
          }
          status={update?.updateAvailable ? 'warning' : 'ok'}
        />
      </SimpleGrid>

      <InstancesList client={client} onOpen={onOpenInstance} onCreate={onCreate} />

      {watchedOperationId ? (
        <Card
          title="Instance creation in progress"
          description="The new instance appears in the list above as soon as the install finishes."
          aside={
            <Button variant="ghost" onClick={onHideWatched}>
              Hide
            </Button>
          }
        >
          <OperationLog client={client} operationId={watchedOperationId} />
        </Card>
      ) : null}

      <Card title="Environment status" description="Checks run automatically when the dashboard loads — re-run them on demand.">
        <Stack gap="md">
          {CHECKS.map((c) => {
            const meta = CHECK_META[c];
            const result = checks?.[c];
            return (
              <CheckRow
                key={c}
                status={checkStatus(result, preflight.isPending)}
                title={meta?.title ?? c}
                description={meta?.description ?? ''}
                detail={result?.detail}
                fix={meta?.fix}
              />
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
    </Stack>
  );
}
