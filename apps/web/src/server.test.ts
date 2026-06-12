// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createOperator, emptyOperatorTable, InMemoryOperatorStore, type OperatorStore } from '@shm/auth';
import { browseUrl, createManagerServer, isLoopbackHost, type ManagerServerHandle } from './server.js';
import type { BootstrapActions } from './actions.js';
import { AuditLog, InstanceLocks, OperationJournal, OperationRunner } from './jobs.js';
import type { ManagerInstanceActions } from './instances.js';

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
    ...overrides,
  };
}

function emptyStore(): OperatorStore {
  return new InMemoryOperatorStore(emptyOperatorTable());
}

function configuredStore(): OperatorStore {
  const created = createOperator(emptyOperatorTable(), {
    email: 'owner@example.com',
    displayName: 'Owner',
    password: 'correct horse battery staple',
    roles: ['server_owner'],
  });
  return new InMemoryOperatorStore(created.table);
}

/**
 * Test servers always bind an EPHEMERAL port: the fixed default (8765) may be
 * taken on a developer machine by a real running manager GUI, and parallel
 * test files must never fight over one port.
 */
function testServer(
  options: Partial<Parameters<typeof createManagerServer>[0]> & { actions: BootstrapActions },
): ManagerServerHandle {
  return createManagerServer({ port: 0, operatorStore: configuredStore(), ...options });
}

let handles: ManagerServerHandle[] = [];

async function start(handle: ManagerServerHandle): Promise<string> {
  handles.push(handle);
  const { host, port } = await handle.listen();
  const h = host === '::1' ? '[::1]' : host;
  return `http://${h}:${port}`;
}

async function login(base: string, email = 'owner@example.com', password = 'correct horse battery staple') {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { cookie, csrfToken };
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

describe('browseUrl', () => {
  it('maps a wildcard bind (in-container) to a localhost URL the operator can open', () => {
    expect(browseUrl('0.0.0.0', 8765)).toBe('http://localhost:8765');
    expect(browseUrl('::', 8765)).toBe('http://localhost:8765');
  });

  it('keeps explicit binds as-is (bracketing IPv6)', () => {
    expect(browseUrl('127.0.0.1', 8765)).toBe('http://127.0.0.1:8765');
    expect(browseUrl('::1', 9000)).toBe('http://[::1]:9000');
  });
});

describe('manager server binding', () => {
  it('binds to 127.0.0.1 by default', async () => {
    const base = await start(testServer({ actions: fakeActions() }));
    expect(base).toContain('127.0.0.1');
  });

  it('refuses a non-loopback bind unless explicitly allowed', () => {
    expect(() => testServer({ actions: fakeActions(), host: '0.0.0.0' })).not.toThrow();
    expect(() => testServer({ actions: fakeActions(), host: '203.0.113.5' })).toThrow(/non-loopback/);
    expect(() => testServer({ actions: fakeActions(), host: '203.0.113.5', allowNonLocal: true })).not.toThrow();
  });

  it('rejects foreign Host headers (DNS-rebinding guard)', async () => {
    // fetch()/undici refuses to override Host, so drive the raw http client.
    const { request } = await import('node:http');
    const base = await start(testServer({ actions: fakeActions() }));
    const { port } = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/auth/meta', headers: { host: 'evil.example.com' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });
});

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

describe('authenticated manager endpoints', () => {
  it('exposes the manager self-update check as GET /api/manager/update-check', async () => {
    const base = await start(
      testServer({
        actions: fakeActions({
          checkManagerUpdate: async () => ({
            currentVersion: '0.1.4',
            latestVersion: '0.2.0',
            updateAvailable: true,
            runtime: 'docker',
            instructions: ['docker pull ghcr.io/humdek-unibe-ch/sh-manager:v0.2.0'],
          }),
        }),
      }),
    );
    const { cookie } = await login(base);
    const res = await fetch(base + '/api/manager/update-check', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updateAvailable: boolean; latestVersion: string };
    expect(body.updateAvailable).toBe(true);
    expect(body.latestVersion).toBe('0.2.0');
  });

  it('lists registry versions against the server-default registry', async () => {
    const calls: { url: string; channel: string }[] = [];
    const base = await start(
      testServer({
        actions: fakeActions({
          listVersions: async (registryUrl, channel) => {
            calls.push({ url: registryUrl, channel });
            return { versions: ['0.2.0', '0.1.0'] };
          },
        }),
        defaultRegistryUrl: 'https://registry.example.com/',
      }),
    );
    const { cookie } = await login(base);
    const res = await fetch(base + '/api/registry/versions', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { versions: string[] }).versions).toEqual(['0.2.0', '0.1.0']);
    expect(calls[0]).toEqual({ url: 'https://registry.example.com/', channel: 'stable' });

    await fetch(base + '/api/registry/versions?channel=test', { headers: { cookie } });
    expect(calls[1]?.channel).toBe('test');
  });

  it('answers /api/state with the manager version and the session identity', async () => {
    const base = await start(testServer({ actions: fakeActions(), managerVersion: '1.0.6' }));
    const { cookie } = await login(base);
    const body = (await (await fetch(base + '/api/state', { headers: { cookie } })).json()) as {
      mode: string;
      managerVersion?: string;
      session?: { email: string };
    };
    expect(body.mode).toBe('persistent');
    expect(body.managerVersion).toBe('1.0.6');
    expect(body.session?.email).toBe('owner@example.com');
  });
});

describe('instance management APIs', () => {
  function fakeInstanceActions(): ManagerInstanceActions {
    return {
      async list() {
        return [
          {
            instanceId: 'clinic-a',
            displayName: 'Clinic A',
            domain: 'a.example.com',
            mode: 'production',
            status: 'active',
            version: '0.1.0',
            updatedAt: '2026-06-01T00:00:00Z',
            brokenReason: null,
            busy: null,
          },
        ];
      },
      async detail(id) {
        if (id !== 'clinic-a') return null;
        return {
          summary: (await this.list())[0]!,
          manifest: null,
          instanceDir: '/opt/selfhelp/instances/clinic-a',
        };
      },
      async backups() {
        return [];
      },
      async health() {
        return { instanceId: 'clinic-a', overall: 'healthy', services: [], checkedAt: '2026-06-01T00:00:00Z' };
      },
      async serverStatus() {
        return { initialized: true, serverId: 'srv-1', proxyNetwork: 'selfhelp-proxy', instanceCount: 1 };
      },
      async mailer(id) {
        if (id !== 'clinic-a') throw new Error('not found');
        return { configured: true, redactedDsn: 'smtp://mailer:***@mail.example.org:587' };
      },
      async updateDryRun() {
        return { status: 'update_available' };
      },
      async create() {
        return { version: '0.1.0' };
      },
      async update() {
        return { executed: true };
      },
      async backup() {
        return { backupId: 'backup-1' };
      },
      async restore() {
        return { restoredFrom: 'backup-1' };
      },
      async clone() {
        return { executed: true };
      },
      async setAddress() {
        return { changed: true, domain: 'b.example.com' };
      },
      async setMailer() {
        return { configured: true, redactedDsn: 'smtp://mailer:***@mail.example.org:587', restarted: true };
      },
      async remove() {
        return { executed: true };
      },
      async hasPendingCmsOperation() {
        return false;
      },
      async drainCmsOperations() {
        return { processed: 0, outcomes: [] };
      },
    };
  }

  async function managementBase(
    tmpRoot: string,
    actions: BootstrapActions = fakeActions(),
  ): Promise<{ base: string; cookie: string; csrfToken: string }> {
    const journal = new OperationJournal(tmpRoot);
    const runner = new OperationRunner(journal, new AuditLog(tmpRoot), new InstanceLocks(tmpRoot));
    const base = await start(
      testServer({
        actions,
        instanceManagement: { instances: fakeInstanceActions(), runner, journal },
      }),
    );
    const { cookie, csrfToken } = await login(base);
    return { base, cookie, csrfToken };
  }

  it('requires authentication for instance APIs', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base } = await managementBase(tmpRoot);
      const res = await fetch(base + '/api/instances');
      expect(res.status).toBe(401);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('serves reads and runs mutations through the journal with 202 + polling', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const authed = { cookie };
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };

      const list = await fetch(base + '/api/instances', { headers: authed });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { instances: { instanceId: string }[] };
      expect(listBody.instances[0]?.instanceId).toBe('clinic-a');

      const detail = await fetch(base + '/api/instances/clinic-a', { headers: authed });
      expect(detail.status).toBe(200);
      expect((await fetch(base + '/api/instances/nope', { headers: authed })).status).toBe(404);
      // Uppercase ids are rejected outright — the CLI only ever creates
      // lowercase ids, so this is a malformed request, not a lookup miss.
      expect((await fetch(base + '/api/instances/Clinic-A', { headers: authed })).status).toBe(400);

      // CSRF applies to instance mutations too.
      const noCsrf = await fetch(base + '/api/instances/clinic-a/backups', { method: 'POST', headers: { cookie } });
      expect(noCsrf.status).toBe(403);

      const accepted = await fetch(base + '/api/instances/clinic-a/backups', { method: 'POST', headers: mutating });
      expect(accepted.status).toBe(202);
      const { operationId } = (await accepted.json()) as { operationId: string };
      expect(operationId).toMatch(/^op-/);

      // Poll until the background body completed.
      let status = 'running';
      for (let i = 0; i < 50 && status === 'running'; i++) {
        const op = await fetch(`${base}/api/operations/${operationId}`, { headers: authed });
        expect(op.status).toBe(200);
        status = ((await op.json()) as { status: string }).status;
        if (status === 'running') await new Promise((r) => setTimeout(r, 10));
      }
      expect(status).toBe('succeeded');

      const ops = await fetch(base + '/api/operations?instanceId=clinic-a', { headers: authed });
      const opsBody = (await ops.json()) as { operations: { id: string }[] };
      expect(opsBody.operations.some((o) => o.id === operationId)).toBe(true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('reports server status and runs the stateless preflight', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const seenPorts: number[][] = [];
      const { base, cookie, csrfToken } = await managementBase(
        tmpRoot,
        fakeActions({
          checkResources: async (ports) => {
            seenPorts.push(ports);
            return { status: 'ok' };
          },
        }),
      );

      const status = await fetch(base + '/api/server/status', { headers: { cookie } });
      expect(status.status).toBe(200);
      expect(((await status.json()) as { initialized: boolean }).initialized).toBe(true);

      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };
      const res = await fetch(base + '/api/server/preflight', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ mode: 'production' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        docker: { ok: boolean };
        internet: { ok: boolean };
        registry: { ok: boolean };
        resources: { ok: boolean };
        registryUrl: string;
      };
      expect(body.docker.ok).toBe(true);
      expect(body.registry.ok).toBe(true);
      expect(body.registryUrl).toMatch(/^https?:\/\//);
      // Production preflight verifies the proxy ports.
      expect(seenPorts[0]).toEqual([80, 443]);

      await fetch(base + '/api/server/preflight', { method: 'POST', headers: mutating, body: JSON.stringify({ mode: 'local' }) });
      expect(seenPorts[1]).toEqual([]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('reads and sets the instance mailer (validating the DSN)', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };

      const get = await fetch(base + '/api/instances/clinic-a/mailer', { headers: { cookie } });
      expect(get.status).toBe(200);
      const mailer = (await get.json()) as { configured: boolean; redactedDsn?: string };
      expect(mailer.configured).toBe(true);
      // Redacted DSN never carries the raw credential.
      expect(mailer.redactedDsn).toContain('***');

      // Garbage DSN is rejected before any operation starts.
      const bad = await fetch(base + '/api/instances/clinic-a/mailer', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ dsn: 'not-a-dsn' }),
      });
      expect(bad.status).toBe(400);

      const ok = await fetch(base + '/api/instances/clinic-a/mailer', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ dsn: 'smtp://user:pass@mail.example.org:587' }),
      });
      expect(ok.status).toBe(202);
      const { operationId } = (await ok.json()) as { operationId: string };
      // Wait for the journaled op to finish so the per-instance lock is free.
      expect(await waitForOperation(base, cookie, operationId)).toBe('succeeded');

      // Clearing is always allowed (falls back to the bundled Mailpit).
      const clear = await fetch(base + '/api/instances/clinic-a/mailer', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ clear: true }),
      });
      expect(clear.status).toBe(202);
      const cleared = (await clear.json()) as { operationId: string };
      expect(await waitForOperation(base, cookie, cleared.operationId)).toBe('succeeded');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('answers 409 when the instance is already locked by another operation', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const locks = new InstanceLocks(tmpRoot);
      const held = await locks.acquire('clinic-a', 'op-existing');
      const res = await fetch(base + '/api/instances/clinic-a/update', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      await held.release();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('validates create requests before starting an operation (and accepts mailer/letsencrypt fields)', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };
      const post = (body: unknown) =>
        fetch(base + '/api/instances', { method: 'POST', headers: mutating, body: JSON.stringify(body) });

      expect((await post({ instanceId: 'x' })).status).toBe(400);

      // A malformed mailer DSN is rejected by the shared validation rules.
      const badMailer = await post({
        instanceId: 'clinic-b',
        displayName: 'Clinic B',
        mode: 'local',
        localPort: 9200,
        adminEmail: 'admin@example.org',
        mailerDsn: 'mail.example.org',
      });
      expect(badMailer.status).toBe(400);
      expect(((await badMailer.json()) as { error: string }).error).toMatch(/Mailer DSN/);

      // registryUrl is optional — the server fills its default registry.
      const ok = await post({
        instanceId: 'clinic-b',
        displayName: 'Clinic B',
        mode: 'local',
        localPort: 9200,
        adminEmail: 'admin@example.org',
        mailerDsn: 'smtp://user:pass@mail.example.org:587',
        letsencryptEmail: 'ops@example.org',
      });
      expect(ok.status).toBe(202);
      const started = (await ok.json()) as { operationId: string };
      expect(await waitForOperation(base, cookie, started.operationId)).toBe('succeeded');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  async function waitForOperation(base: string, cookie: string, operationId: string): Promise<string> {
    let status = 'running';
    for (let i = 0; i < 50 && status === 'running'; i++) {
      const op = await fetch(`${base}/api/operations/${operationId}`, { headers: { cookie } });
      status = ((await op.json()) as { status: string }).status;
      if (status === 'running') await new Promise((r) => setTimeout(r, 10));
    }
    return status;
  }

  it('clones a production source by domain and rejects a missing/duplicate domain', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };
      const post = (body: unknown) =>
        fetch(base + '/api/instances/clinic-a/clone', { method: 'POST', headers: mutating, body: JSON.stringify(body) });

      // Production source (fake detail says mode=production): a port is not enough.
      expect((await post({ targetInstanceId: 'clinic-b', targetLocalPort: 9124 })).status).toBe(400);
      // Reusing the source domain is refused.
      expect((await post({ targetInstanceId: 'clinic-b', targetDomain: 'a.example.com' })).status).toBe(400);
      // A fresh domain is accepted and journaled.
      const ok = await post({ targetInstanceId: 'clinic-b', targetDomain: 'b.example.com' });
      expect(ok.status).toBe(202);
      const { operationId } = (await ok.json()) as { operationId: string };
      await waitForOperation(base, cookie, operationId);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('changes an instance address through the journal and validates the input', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };
      const post = (body: unknown) =>
        fetch(base + '/api/instances/clinic-a/address', { method: 'POST', headers: mutating, body: JSON.stringify(body) });

      // Production instance: a localPort alone is invalid, a bad hostname too.
      expect((await post({ localPort: 9124 })).status).toBe(400);
      expect((await post({ domain: 'not a domain' })).status).toBe(400);
      const ok = await post({ domain: 'new.example.com' });
      expect(ok.status).toBe(202);
      const { operationId } = (await ok.json()) as { operationId: string };
      expect(operationId).toMatch(/^op-/);
      expect(await waitForOperation(base, cookie, operationId)).toBe('succeeded');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
