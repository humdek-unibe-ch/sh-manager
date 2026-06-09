// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, afterEach } from 'vitest';
import { createOperator, emptyOperatorTable, InMemoryOperatorStore } from '@shm/auth';
import { createBootstrapServer, isLoopbackHost, type BootstrapServerHandle } from './server.js';
import type { BootstrapActions } from './actions.js';

function fakeActions(overrides: Partial<BootstrapActions> = {}): BootstrapActions {
  return {
    async checkDocker() {
      return { dockerAvailable: true, dockerComposeAvailable: true };
    },
    async checkInternet() {
      return { ok: true, severity: 'ok' };
    },
    async checkRegistry() {
      return { ok: true, signatureVerified: true };
    },
    async checkResources() {
      return { status: 'ok' };
    },
    async runInstall() {
      return { ok: true, instanceDir: '/opt/selfhelp/instances/clinic-a', version: '0.1.0', publicUrl: 'https://app.example.com' };
    },
    async checkHealth() {
      return { healthy: true, degraded: false };
    },
    ...overrides,
  };
}

interface Snap {
  step: string;
  stepIndex: number;
  steps: string[];
  completed: boolean;
  publicUrl?: string;
  outcome?: { ok: boolean };
  health?: { healthy: boolean };
}

async function snap(res: Response): Promise<Snap> {
  return (await res.json()) as Snap;
}

const FULL_CONFIG = {
  root: '/opt/selfhelp',
  serverId: 'srv-1',
  mode: 'production',
  domain: 'app.example.com',
  letsencryptEmail: 'ops@example.com',
  registryUrl: 'https://registry.example.com/',
  channel: 'stable',
  version: 'latest',
  instanceId: 'clinic-a',
  instanceName: 'Clinic A',
  adminEmail: 'admin@example.com',
  adminName: 'Admin',
};

let handles: BootstrapServerHandle[] = [];

async function start(handle: BootstrapServerHandle): Promise<string> {
  handles.push(handle);
  const { host, port } = await handle.listen();
  const h = host === '::1' ? '[::1]' : host;
  return `http://${h}:${port}`;
}

afterEach(async () => {
  await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
  handles = [];
});

describe('isLoopbackHost', () => {
  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('bootstrap server binding', () => {
  it('binds to 127.0.0.1 by default', async () => {
    const base = await start(createBootstrapServer({ actions: fakeActions() }));
    expect(base).toContain('127.0.0.1');
  });

  it('refuses a non-loopback bind unless explicitly allowed', () => {
    expect(() => createBootstrapServer({ actions: fakeActions(), host: '0.0.0.0' })).not.toThrow();
    expect(() => createBootstrapServer({ actions: fakeActions(), host: '203.0.113.5' })).toThrow(/non-loopback/);
    expect(() => createBootstrapServer({ actions: fakeActions(), host: '203.0.113.5', allowNonLocal: true })).not.toThrow();
  });
});

describe('bootstrap wizard over HTTP', () => {
  it('drives the whole flow and self-locks after completion', async () => {
    const base = await start(createBootstrapServer({ actions: fakeActions() }));

    const post = (p: string, body?: unknown) =>
      fetch(base + p, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

    // welcome -> docker
    await post('/api/config', FULL_CONFIG);
    let s = await snap(await post('/api/advance'));
    expect(s.step).toBe('docker');

    // run each gated check then advance
    const order = ['docker', 'internet', 'registry', 'install_root', 'resources', 'mode', 'domain', 'proxy', 'instance', 'admin'];
    for (const expected of order) {
      expect(s.step).toBe(expected);
      if (['docker', 'internet', 'registry', 'resources'].includes(expected)) {
        await post('/api/check/' + expected);
      }
      s = await snap(await post('/api/advance'));
    }
    expect(s.step).toBe('install');

    const installRes = await snap(await post('/api/install'));
    expect(installRes.outcome?.ok).toBe(true);
    expect(installRes.publicUrl).toBe('https://app.example.com');

    s = await snap(await post('/api/advance')); // install -> health
    expect(s.step).toBe('health');
    s = await snap(await post('/api/advance')); // health -> done
    expect(s.step).toBe('done');
    expect(s.completed).toBe(true);

    // Bootstrap UI is now disabled: mutating routes 410, state still readable.
    const locked = await post('/api/config', { root: '/tmp' });
    expect(locked.status).toBe(410);
    const stateAfter = await fetch(base + '/api/state');
    expect(stateAfter.status).toBe(200);
  });

  it('returns 409 with a reason when advancing past a failed check', async () => {
    const base = await start(createBootstrapServer({ actions: fakeActions({ checkDocker: async () => ({ dockerAvailable: false, dockerComposeAvailable: false }) }) }));
    const post = (p: string, body?: unknown) =>
      fetch(base + p, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    await post('/api/config', FULL_CONFIG);
    await post('/api/advance'); // -> docker
    await post('/api/check/docker'); // records a failing result
    const res = await post('/api/advance');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Docker/i);
  });
});

describe('persistent mode authentication', () => {
  async function persistentBase(): Promise<{ base: string }> {
    const created = createOperator(emptyOperatorTable(), {
      email: 'owner@example.com',
      displayName: 'Owner',
      password: 'correct horse battery staple',
      roles: ['server_owner'],
    });
    const store = new InMemoryOperatorStore(created.table);
    const base = await start(createBootstrapServer({ actions: fakeActions(), mode: 'persistent', operatorStore: store }));
    return { base };
  }

  it('rejects API access without a session', async () => {
    const { base } = await persistentBase();
    const res = await fetch(base + '/api/state');
    expect(res.status).toBe(401);
  });

  it('allows access after login and enforces CSRF on mutations', async () => {
    const { base } = await persistentBase();
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery staple' }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0] ?? '';
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    expect(cookie).toContain('shm_session=');

    // Authenticated GET works.
    const state = await fetch(base + '/api/state', { headers: { cookie } });
    expect(state.status).toBe(200);

    // Mutation without CSRF is refused.
    const noCsrf = await fetch(base + '/api/config', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    expect(noCsrf.status).toBe(403);

    // Mutation with the right CSRF token succeeds.
    const withCsrf = await fetch(base + '/api/config', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken },
      body: JSON.stringify({ instanceName: 'Renamed' }),
    });
    expect(withCsrf.status).toBe(200);
  });

  it('rejects bad credentials', async () => {
    const { base } = await persistentBase();
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
  });
});
