// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Authenticated operations console (persistent mode), laid out as a Mantine
 * AppShell — the same admin-panel structure operators know from the SelfHelp
 * CMS UI: instances live in the LEFT SIDEBAR (with live status dots), the
 * CENTER shows either the server dashboard or the selected instance's
 * workspace, and the header carries the brand, the signed-in operator and the
 * sign-out action.
 *
 * All instance mutations run through the BFF job layer and are watched via
 * the operation journal — the GUI shows real logs, never imagined state.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AppShell as MantineAppShell,
  Box,
  Burger,
  Divider,
  Group,
  NavLink,
  ScrollArea,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Brand, Button, StatusBadge, type BadgeTone } from '../../components';
import type { ApiClient } from '../../lib/api-client';
import type { InstanceSummary } from '../../lib/types';
import { ConsoleDashboard, CONSOLE_STATE_KEY } from './ConsoleDashboard';
import { CreateInstanceWizard } from './CreateInstanceWizard';
import { InstanceDetail } from './InstanceDetail';
import { INSTANCES_KEY, instanceStatusTone } from './InstancesList';
import { parseConsoleRoute, CREATE_INSTANCE_ROUTE } from './console-route';
import { useManagerEvents } from './use-manager-events';
import { managerFallbackInterval, useManagerSseConnected } from './manager-sse-status';

const DOT_COLOR: Record<BadgeTone, string> = {
  ok: 'var(--mantine-color-teal-6)',
  warning: 'var(--mantine-color-yellow-6)',
  error: 'var(--mantine-color-red-6)',
  info: 'var(--mantine-color-blue-6)',
  neutral: 'var(--mantine-color-gray-5)',
  pending: 'var(--mantine-color-gray-5)',
};

function StatusDot({ instance }: { instance: InstanceSummary }): JSX.Element {
  const tone = instanceStatusTone(instance.status);
  const label = instance.busy ? `${instance.status} · operation running` : instance.status;
  return (
    <Tooltip label={label}>
      <Box
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: DOT_COLOR[tone],
          flexShrink: 0,
        }}
      />
    </Tooltip>
  );
}

export interface OperationsConsoleProps {
  client: ApiClient;
  /** Sign-out handler (owned by the app shell so the state query resets). */
  onSignOut?: () => void;
}

export function OperationsConsole({ client, onSignOut }: OperationsConsoleProps): JSX.Element {
  const queryClient = useQueryClient();
  // Live operation/command progress via the BFF Server-Sent-Events stream. The
  // query polling below is a fallback that only runs while the stream is down.
  useManagerEvents();
  const sseConnected = useManagerSseConnected();
  const navigate = useNavigate();
  const location = useLocation();
  // The console is a single mounted shell, so it derives its view from the
  // pathname rather than from `<Route>` params (see `parseConsoleRoute`).
  const { instanceId, view } = parseConsoleRoute(location.pathname);
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  /** `null` = dashboard, otherwise the selected instance id. */
  const selectedId = instanceId ?? null;
  const createOpen = view === 'new';
  /** Operation started from the create wizard — watched on the dashboard. */
  const [watchedOperationId, setWatchedOperationId] = useState<string | null>(null);

  const stateQuery = useQuery({ queryKey: CONSOLE_STATE_KEY, queryFn: () => client.getState() });
  const snapshot = stateQuery.data ?? null;
  const instancesQuery = useQuery({
    queryKey: INSTANCES_KEY,
    queryFn: () => client.listInstances(),
    refetchInterval: managerFallbackInterval(sseConnected, 10_000),
  });
  const instances = instancesQuery.data ?? [];

  // First-run experience: a server with no instances goes straight into the
  // guided install wizard (once — closing it returns to the dashboard).
  const autoOpenedWizard = useRef(false);
  useEffect(() => {
    if (autoOpenedWizard.current) return;
    if (instancesQuery.data && instancesQuery.data.length === 0) {
      autoOpenedWizard.current = true;
      navigate(CREATE_INSTANCE_ROUTE);
    }
  }, [instancesQuery.data, navigate]);

  const select = (id: string | null): void => {
    navigate(id ? `/instances/${id}` : '/');
    closeNav();
  };

  return (
    <MantineAppShell
      header={{ height: 64 }}
      navbar={{ width: 300, breakpoint: 'sm', collapsed: { mobile: !navOpened } }}
      padding="lg"
    >
      <MantineAppShell.Header px="md">
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={navOpened} onClick={toggleNav} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <Brand subtitle="Operations console" version={snapshot?.managerVersion} />
          </Group>
          <Group gap="sm" wrap="nowrap">
            {snapshot?.session?.email ? (
              <Text size="sm" c="dimmed" visibleFrom="sm">
                {snapshot.session.email}
              </Text>
            ) : null}
            <Button variant="ghost" onClick={() => onSignOut?.()}>
              Sign out
            </Button>
          </Group>
        </Group>
      </MantineAppShell.Header>

      <MantineAppShell.Navbar p="sm">
        <MantineAppShell.Section>
          <NavLink
            component="button"
            type="button"
            label="Dashboard"
            description="Server status & environment checks"
            active={selectedId === null}
            onClick={() => select(null)}
            aria-label="Dashboard"
            style={{ borderRadius: 'var(--mantine-radius-sm)' }}
          />
        </MantineAppShell.Section>

        <Divider my="sm" />
        <Group justify="space-between" px="xs" pb={6} wrap="nowrap">
          <Text size="xs" tt="uppercase" fw={700} c="dimmed">
            Instances
          </Text>
          <StatusBadge tone="neutral" dot={false}>
            {String(instances.length)}
          </StatusBadge>
        </Group>

        <MantineAppShell.Section grow component={ScrollArea}>
          {instances.length === 0 ? (
            <Text size="sm" c="dimmed" px="xs" py="sm">
              {instancesQuery.isPending ? 'Loading instances…' : 'No instances yet — create the first one below.'}
            </Text>
          ) : (
            instances.map((inst) => (
              <NavLink
                key={inst.instanceId}
                component="button"
                type="button"
                label={inst.displayName || inst.instanceId}
                description={`${inst.instanceId}${inst.domain ? ` · ${inst.domain}` : ''}`}
                active={selectedId === inst.instanceId}
                onClick={() => select(inst.instanceId)}
                aria-label={`Instance ${inst.instanceId}`}
                leftSection={<StatusDot instance={inst} />}
                style={{ borderRadius: 'var(--mantine-radius-sm)' }}
              />
            ))
          )}
        </MantineAppShell.Section>

        <MantineAppShell.Section>
          <Divider my="sm" />
          <Button variant="primary" block onClick={() => navigate(CREATE_INSTANCE_ROUTE)}>
            New instance
          </Button>
        </MantineAppShell.Section>
      </MantineAppShell.Navbar>

      <MantineAppShell.Main>
        {createOpen ? (
          // Full-page guided install (the only install flow; on a fresh
          // server its first run also bootstraps the proxy + inventory).
          <CreateInstanceWizard
            key={String(createOpen)}
            client={client}
            onClose={() => navigate('/')}
            onStarted={(operationId) => {
              setWatchedOperationId(operationId);
              // The new instance shows up in the inventory as the install
              // progresses; refresh the list immediately and let its regular
              // polling pick up later state changes.
              void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
            }}
            onOpenInstance={(instanceId) => {
              void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
              navigate(`/instances/${instanceId}`);
            }}
          />
        ) : selectedId === null ? (
          <ConsoleDashboard
            client={client}
            instances={instances}
            onOpenInstance={select}
            onCreate={() => navigate(CREATE_INSTANCE_ROUTE)}
            watchedOperationId={watchedOperationId}
            onHideWatched={() => setWatchedOperationId(null)}
          />
        ) : (
          <InstanceDetail key={selectedId} client={client} instanceId={selectedId} />
        )}
      </MantineAppShell.Main>
    </MantineAppShell>
  );
}
