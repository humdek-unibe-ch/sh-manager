// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Top-level router. There is ONE experience: the authenticated operations
 * console. Before a session exists the app shows sign-in — or, on a fresh
 * manager with no operator accounts yet, the first-run "create operator"
 * form. A single API client is shared so the CSRF token captured at
 * login/setup flows into every later request.
 */
import { useCallback, useMemo } from 'react';
import { Center, Stack } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AppShell, Button, Spinner, StatusBadge } from './components';
import { LoginForm } from './features/auth/LoginForm';
import { FirstRunSetup } from './features/auth/FirstRunSetup';
import { OperationsConsole } from './features/manager/OperationsConsole';
import { ApiError, createApiClient, type ApiClient } from './lib/api-client';

type View = 'loading' | 'setup' | 'login' | 'console' | 'error';

const STATE_KEY = ['manager', 'state'] as const;
const AUTH_META_KEY = ['auth', 'meta'] as const;

export interface AppProps {
  /** Injected for tests; defaults to the real BFF client. */
  client?: ApiClient;
}

export function App({ client: injected }: AppProps = {}): JSX.Element {
  const client = useMemo(() => injected ?? createApiClient(), [injected]);
  const queryClient = useQueryClient();

  const stateQuery = useQuery({
    queryKey: STATE_KEY,
    queryFn: () => client.getState(),
    retry: false,
  });
  const unauthorized =
    stateQuery.isError && stateQuery.error instanceof ApiError && stateQuery.error.status === 401;

  // Pre-auth metadata: tells the sign-in screen whether ANY operator account
  // exists (first run → setup form) and carries the manager version.
  const metaQuery = useQuery({
    queryKey: AUTH_META_KEY,
    queryFn: () => client.getAuthMeta(),
    enabled: unauthorized,
  });

  const refetchState = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: STATE_KEY });
    void queryClient.invalidateQueries({ queryKey: AUTH_META_KEY });
  }, [queryClient]);

  const signOut = useCallback(async () => {
    try {
      await client.logout();
    } catch {
      // ignore — we always return to the sign-in screen.
    }
    refetchState();
  }, [client, refetchState]);

  const view: View = stateQuery.isPending
    ? 'loading'
    : unauthorized
      ? metaQuery.isPending
        ? 'loading'
        : metaQuery.data?.operatorsConfigured === false
          ? 'setup'
          : 'login'
      : stateQuery.isError
        ? 'error'
        : 'console';

  // The console brings its own admin shell (sidebar + header, like the CMS
  // admin UI); every other view uses the simple centered page chrome.
  if (view === 'console') {
    return <OperationsConsole client={client} onSignOut={() => void signOut()} />;
  }

  const subtitle = view === 'setup' ? 'First-run setup' : view === 'login' ? 'Sign in' : undefined;
  const version = stateQuery.data?.managerVersion ?? metaQuery.data?.managerVersion;

  return (
    <AppShell
      subtitle={subtitle}
      {...(version ? { version } : {})}
      headerActions={view === 'setup' || view === 'login' ? <StatusBadge tone="neutral">Localhost</StatusBadge> : null}
    >
      {view === 'loading' ? (
        <Center mih="50vh">
          <Spinner size="lg" label="Loading manager" />
        </Center>
      ) : view === 'error' ? (
        <Center mih="50vh">
          <Stack maw={460} w="100%" gap="md">
            <Alert tone="error" title="Cannot reach the manager service">
              {stateQuery.error instanceof Error
                ? stateQuery.error.message
                : 'The manager service is not responding.'}
            </Alert>
            <Button variant="primary" onClick={refetchState}>
              Try again
            </Button>
          </Stack>
        </Center>
      ) : view === 'setup' ? (
        <FirstRunSetup client={client} onSuccess={refetchState} />
      ) : (
        <LoginForm client={client} onSuccess={refetchState} />
      )}
    </AppShell>
  );
}
