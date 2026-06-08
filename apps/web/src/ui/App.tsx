// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Top-level router. Detects the server mode from the BFF and shows the right
 * experience: the bootstrap installer (localhost, unauthenticated) or the
 * authenticated operations console (persistent mode). A single API client is
 * shared so the CSRF token captured at login flows into every later request.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AppShell, Button, Spinner, StatusBadge } from './components';
import { BootstrapWizard } from './features/bootstrap/BootstrapWizard';
import { LoginForm } from './features/auth/LoginForm';
import { OperationsConsole } from './features/manager/OperationsConsole';
import { ApiError, createApiClient } from './lib/api-client';

type View = 'loading' | 'bootstrap' | 'login' | 'console' | 'error';

export function App(): JSX.Element {
  const client = useMemo(() => createApiClient(), []);
  const [view, setView] = useState<View>('loading');
  const [error, setError] = useState<string | null>(null);

  const detect = useCallback(async () => {
    setView('loading');
    setError(null);
    try {
      const snap = await client.getState();
      setView(snap.mode === 'persistent' ? 'console' : 'bootstrap');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setView('login');
        return;
      }
      setError(err instanceof Error ? err.message : 'The manager service is not responding.');
      setView('error');
    }
  }, [client]);

  useEffect(() => {
    void detect();
  }, [detect]);

  const signOut = useCallback(async () => {
    try {
      await client.logout();
    } catch {
      // ignore — we always return to the sign-in screen.
    }
    setView('login');
  }, [client]);

  const subtitle =
    view === 'bootstrap'
      ? 'Server bootstrap'
      : view === 'console'
        ? 'Operations console'
        : view === 'login'
          ? 'Sign in'
          : undefined;

  const headerActions =
    view === 'console' ? (
      <Button variant="ghost" onClick={() => void signOut()}>
        Sign out
      </Button>
    ) : view === 'bootstrap' || view === 'login' ? (
      <StatusBadge tone="neutral">Localhost</StatusBadge>
    ) : null;

  return (
    <AppShell subtitle={subtitle} headerActions={headerActions}>
      {view === 'loading' ? (
        <div className="shm-center">
          <Spinner size="lg" label="Loading manager" />
        </div>
      ) : view === 'error' ? (
        <div className="shm-center">
          <div className="shm-auth shm-stack shm-stack--4">
            <Alert tone="error" title="Cannot reach the manager service">
              {error}
            </Alert>
            <Button variant="primary" onClick={() => void detect()}>
              Try again
            </Button>
          </div>
        </div>
      ) : view === 'bootstrap' ? (
        <BootstrapWizard client={client} />
      ) : view === 'login' ? (
        <LoginForm client={client} onSuccess={() => void detect()} />
      ) : (
        <OperationsConsole client={client} />
      )}
    </AppShell>
  );
}
