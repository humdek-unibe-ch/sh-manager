// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Top-level router. Detects the server mode from the BFF (via react-query) and
 * shows the right experience: the bootstrap installer (localhost,
 * unauthenticated) or the authenticated operations console (persistent mode). A
 * single API client is shared so the CSRF token captured at login flows into
 * every later request.
 */
import { useCallback, useMemo } from 'react';
import { Center, Stack } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AppShell, Button, Spinner, StatusBadge } from './components';
import { BootstrapWizard } from './features/bootstrap/BootstrapWizard';
import { LoginForm } from './features/auth/LoginForm';
import { OperationsConsole } from './features/manager/OperationsConsole';
import { ApiError, createApiClient, type ApiClient } from './lib/api-client';

type View = 'loading' | 'bootstrap' | 'login' | 'console' | 'error';

const STATE_KEY = ['manager', 'state'] as const;

export interface AppProps {
  /** Injected for tests; defaults to the real BFF client. */
  client?: ApiClient;
}

export function App({ client: injected }: AppProps = {}): JSX.Element {
  const client = useMemo(() => injected ?? createApiClient(), [injected]);
  const queryClient = useQueryClient();

  const stateQuery = useQuery({ queryKey: STATE_KEY, queryFn: () => client.getState() });

  const refetchState = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: STATE_KEY });
  }, [queryClient]);

  const signOut = useCallback(async () => {
    try {
      await client.logout();
    } catch {
      // ignore — we always return to the sign-in screen.
    }
    await queryClient.invalidateQueries({ queryKey: STATE_KEY });
  }, [client, queryClient]);

  const unauthorized =
    stateQuery.isError && stateQuery.error instanceof ApiError && stateQuery.error.status === 401;

  const view: View = stateQuery.isPending
    ? 'loading'
    : unauthorized
      ? 'login'
      : stateQuery.isError
        ? 'error'
        : stateQuery.data.mode === 'persistent'
          ? 'console'
          : 'bootstrap';

  const subtitle =
    view === 'bootstrap' ? 'Server bootstrap' : view === 'login' ? 'Sign in' : undefined;

  const headerActions =
    view === 'bootstrap' || view === 'login' ? <StatusBadge tone="neutral">Localhost</StatusBadge> : null;

  // The console brings its own admin shell (sidebar + header, like the CMS
  // admin UI); every other view uses the simple centered page chrome.
  if (view === 'console') {
    return <OperationsConsole client={client} onSignOut={() => void signOut()} />;
  }

  return (
    <AppShell subtitle={subtitle} version={stateQuery.data?.managerVersion} headerActions={headerActions}>
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
      ) : view === 'bootstrap' ? (
        <BootstrapWizard client={client} />
      ) : (
        <LoginForm client={client} onSuccess={refetchState} />
      )}
    </AppShell>
  );
}
