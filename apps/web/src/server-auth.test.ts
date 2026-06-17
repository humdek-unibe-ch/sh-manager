// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Login / session / CSRF authentication and first-run operator setup.
 *
 * Split out of the original monolithic `server.test.ts`; the shared BFF
 * harness (fake actions/stores, ephemeral test server, login, SPA dir +
 * cleanup) lives in `server-test-support`. The test bodies are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { emptyStore, fakeActions, login, makeSpaDir, start, testServer } from './server-test-support.js';

describe('authentication', () => {
  it('rejects API access without a session', async () => {
    const base = await start(testServer({ actions: fakeActions() }));
    expect((await fetch(base + '/api/state')).status).toBe(401);
    expect((await fetch(base + '/api/instances')).status).toBe(401);
    expect((await fetch(base + '/api/manager/update-check')).status).toBe(401);
  });

  it('exposes only a boolean pre-auth (auth/meta) and the static shell', async () => {
    const base = await start(testServer({ actions: fakeActions(), managerVersion: '9.9.9' }));
    const meta = await fetch(base + '/api/auth/meta');
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as { operatorsConfigured: boolean; managerVersion?: string };
    expect(body.operatorsConfigured).toBe(true);
    expect(body.managerVersion).toBe('9.9.9');
    expect(JSON.stringify(body)).not.toContain('owner@example.com');

    expect((await fetch(base + '/')).status).toBe(200);
  });

  it('serves the SPA shell as no-cache but hashed assets immutable (so a manager update is picked up)', async () => {
    // Regression: serveStatic set no Cache-Control, so browsers cached
    // index.html and kept loading the OLD hashed bundle after a manager update
    // ("I ran the update but still see the old GUI"). The shell must revalidate;
    // content-hashed files under assets/ are safe to cache forever.
    const dir = await makeSpaDir();
    const base = await start(testServer({ actions: fakeActions(), clientDir: dir }));

    const shell = await fetch(base + '/');
    expect(shell.status).toBe(200);
    expect(shell.headers.get('cache-control')).toBe('no-cache');

    const asset = await fetch(base + '/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('allows access after login and enforces CSRF on mutations', async () => {
    const base = await start(testServer({ actions: fakeActions() }));
    const { cookie, csrfToken } = await login(base);
    expect(cookie).toContain('shm_session=');

    const state = await fetch(base + '/api/state', { headers: { cookie } });
    expect(state.status).toBe(200);

    // Mutation without CSRF is refused; with the token it succeeds.
    const noCsrf = await fetch(base + '/api/logout', { method: 'POST', headers: { cookie } });
    expect(noCsrf.status).toBe(403);
    const withCsrf = await fetch(base + '/api/logout', { method: 'POST', headers: { cookie, 'x-shm-csrf': csrfToken } });
    expect(withCsrf.status).toBe(200);
  });

  it('rejects bad credentials', async () => {
    const base = await start(testServer({ actions: fakeActions() }));
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
  });

  it('recovers the CSRF token from /api/state so reloads keep mutations working', async () => {
    // Regression: the SPA held the CSRF token only in memory, so after a page
    // reload every POST — including sign out — failed with 403 even though
    // the session cookie was still valid.
    const base = await start(testServer({ actions: fakeActions() }));
    const { cookie } = await login(base);

    // Simulated reload: a fresh client knows only the cookie, not the token.
    const state = (await (await fetch(base + '/api/state', { headers: { cookie } })).json()) as {
      session?: { email: string; csrfToken: string };
    };
    expect(state.session?.email).toBe('owner@example.com');
    expect(state.session?.csrfToken).toBeTruthy();

    const logout = await fetch(base + '/api/logout', {
      method: 'POST',
      headers: { cookie, 'x-shm-csrf': state.session!.csrfToken },
    });
    expect(logout.status).toBe(200);

    const after = await fetch(base + '/api/state', { headers: { cookie } });
    expect(after.status).toBe(401);
  });
});

describe('first-run operator setup', () => {
  it('reports operatorsConfigured=false and creates the first operator with a session', async () => {
    const store = emptyStore();
    const base = await start(testServer({ actions: fakeActions(), operatorStore: store }));

    const meta = (await (await fetch(base + '/api/auth/meta')).json()) as { operatorsConfigured: boolean };
    expect(meta.operatorsConfigured).toBe(false);

    const res = await fetch(base + '/api/setup/operator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.org', password: 'a sufficiently long pw' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; roles: string[]; csrfToken: string };
    expect(body.email).toBe('first@example.org');
    expect(body.roles).toContain('server_owner');

    // The setup response signs the operator in (cookie + CSRF token).
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const state = await fetch(base + '/api/state', { headers: { cookie } });
    expect(state.status).toBe(200);

    // And the account persists: meta flips, login works.
    const after = (await (await fetch(base + '/api/auth/meta')).json()) as { operatorsConfigured: boolean };
    expect(after.operatorsConfigured).toBe(true);
  });

  it('hard-locks once any operator exists (409) — never a backdoor on a configured manager', async () => {
    const base = await start(testServer({ actions: fakeActions() }));
    const res = await fetch(base + '/api/setup/operator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'evil@example.org', password: 'a sufficiently long pw' }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects weak passwords with the policy reason', async () => {
    const base = await start(testServer({ actions: fakeActions(), operatorStore: emptyStore() }));
    const res = await fetch(base + '/api/setup/operator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.org', password: 'short' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/12 characters/);
  });
});
