// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, userEvent } from './test/render';
import { App } from './App';
import { makeFakeClient, FULL_CONFIG } from './test/fake-client';
import { ApiError, type ApiClient } from './lib/api-client';
import type { Snapshot } from './lib/types';

function persistentClient(): ApiClient {
  const snap: Snapshot = {
    mode: 'persistent',
    step: 'welcome',
    stepIndex: 0,
    steps: [],
    config: FULL_CONFIG,
    checks: {},
    completed: false,
    canAdvance: { ok: false },
  };
  const same = async (): Promise<Snapshot> => snap;
  return {
    getState: same,
    setConfig: same,
    advance: same,
    back: same,
    runCheck: same,
    install: same,
    managerUpdateCheck: async () => ({
      currentVersion: '0.1.4',
      latestVersion: '0.1.4',
      updateAvailable: false,
      runtime: 'docker',
      instructions: [],
    }),
    login: async () => ({ ok: true, email: 'owner@example.com', roles: ['server_owner'], csrfToken: 't' }),
    logout: async () => {},
  };
}

function throwingClient(err: unknown): ApiClient {
  const fail = (): Promise<never> => Promise.reject(err);
  return {
    getState: fail,
    setConfig: fail,
    advance: fail,
    back: fail,
    runCheck: fail,
    install: fail,
    managerUpdateCheck: fail,
    login: fail,
    logout: async () => {},
  };
}

describe('App routing', () => {
  it('shows the bootstrap installer when the server is in bootstrap mode', async () => {
    render(<App client={makeFakeClient()} />);
    expect(await screen.findByText(/Set up SelfHelp on this server/i)).toBeInTheDocument();
  });

  it('shows the operations console when the server is in persistent mode', async () => {
    render(<App client={persistentClient()} />);
    expect(await screen.findByText('Server operations')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('shows the login screen when the BFF reports 401 Unauthorized', async () => {
    render(<App client={throwingClient(new ApiError(401, 'Authentication required.'))} />);
    expect(await screen.findByText('Sign in to SelfHelp Manager')).toBeInTheDocument();
  });

  it('shows a recoverable error view when the BFF is unreachable', async () => {
    const user = userEvent.setup();
    render(<App client={throwingClient(new ApiError(503, 'The manager service is starting up.'))} />);

    expect(await screen.findByText('Cannot reach the manager service')).toBeInTheDocument();
    expect(screen.getByText('The manager service is starting up.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled();
    // The retry control exists and is clickable (re-runs the state query).
    await user.click(screen.getByRole('button', { name: /try again/i }));
  });
});
