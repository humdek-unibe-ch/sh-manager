// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, userEvent } from './test/render';
import { App } from './App';
import { makeFakeClient } from './test/fake-client';
import { ApiError, type ApiClient } from './lib/api-client';

/** A client whose session-gated routes 401 (signed out) with configurable auth meta. */
function signedOutClient(operatorsConfigured: boolean): ApiClient {
  const base = makeFakeClient({ operatorsConfigured });
  return {
    ...base,
    getState: () => Promise.reject(new ApiError(401, 'Authentication required.')),
  };
}

function throwingClient(err: unknown): ApiClient {
  const fail = (): Promise<never> => Promise.reject(err);
  // Every ApiClient method rejects (kept exhaustive via the fake's key set).
  const failing = Object.fromEntries(Object.keys(makeFakeClient()).map((key) => [key, fail]));
  return { ...failing, logout: async () => {} } as unknown as ApiClient;
}

describe('App routing', () => {
  it('shows the operations console when the session is valid', async () => {
    render(<App client={makeFakeClient()} />);
    expect(await screen.findByText('Server operations')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('shows the login screen when the BFF reports 401 and operators exist', async () => {
    render(<App client={signedOutClient(true)} />);
    expect(await screen.findByText('Sign in to SelfHelp Manager')).toBeInTheDocument();
  });

  it('shows the first-run setup when the BFF reports 401 and NO operator exists yet', async () => {
    render(<App client={signedOutClient(false)} />);
    expect(await screen.findByText('Welcome to SelfHelp Manager')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
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
