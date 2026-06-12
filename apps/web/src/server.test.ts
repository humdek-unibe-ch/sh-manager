// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createOperator, emptyOperatorTable, InMemoryOperatorStore } from '@shm/auth';
import { browseUrl, createBootstrapServer, isLoopbackHost, type BootstrapServerHandle } from './server.js';
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

/**
 * Test servers always bind an EPHEMERAL port: the fixed default (8765) may be
 * taken on a developer machine by a real running manager GUI, and parallel
 * test files must never fight over one port.
 */
function testServer(options: Parameters<typeof createBootstrapServer>[0]): BootstrapServerHandle {
  return createBootstrapServer({ port: 0, ...options });
}

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

describe('bootstrap server binding', () => {
  it('binds to 127.0.0.1 by default', async () => {
    const base = await start(testServer({ actions: fakeActions() }));
    expect(base).toContain('127.0.0.1');
  });

  it('refuses a non-loopback bind unless explicitly allowed', () => {
    expect(() => testServer({ actions: fakeActions(), host: '0.0.0.0' })).not.toThrow();
    expect(() => testServer({ actions: fakeActions(), host: '203.0.113.5' })).toThrow(/non-loopback/);
    expect(() => testServer({ actions: fakeActions(), host: '203.0.113.5', allowNonLocal: true })).not.toThrow();
  });
});

describe('bootstrap wizard over HTTP', () => {
  it('drives the whole flow and self-locks after completion', async () => {
    const base = await start(testServer({ actions: fakeActions() }));

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

  it('returns the generated admin password ONLY on the one-shot install response, never in state', async () => {
    const base = await start(
      testServer({
        actions: fakeActions({
          async runInstall() {
            return {
              ok: true,
              instanceDir: '/opt/selfhelp/instances/clinic-a',
              version: '0.1.0',
              publicUrl: 'https://app.example.com',
              adminPassword: 'gen-pw-shown-once-12345',
              adminPasswordFile: '/opt/selfhelp/instances/clinic-a/secrets/admin_password',
            };
          },
        }),
        persistAfterBootstrap: true,
      }),
    );
    const post = (p: string, body?: unknown) =>
      fetch(base + p, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

    await post('/api/config', FULL_CONFIG);
    let s = await snap(await post('/api/advance'));
    for (const step of ['docker', 'internet', 'registry', 'install_root', 'resources', 'mode', 'domain', 'proxy', 'instance', 'admin']) {
      if (['docker', 'internet', 'registry', 'resources'].includes(step)) await post('/api/check/' + step);
      s = await snap(await post('/api/advance'));
    }
    expect(s.step).toBe('install');

    // The one-shot install response carries the password + its server-side file…
    const res = await post('/api/install');
    const body = (await res.json()) as { outcome?: { adminPassword?: string; adminPasswordFile?: string } };
    expect(body.outcome?.adminPassword).toBe('gen-pw-shown-once-12345');
    expect(body.outcome?.adminPasswordFile).toContain('secrets/admin_password');

    // …but no later state snapshot ever does ("retrieved from the server, shown once").
    const stateText = JSON.stringify(await (await fetch(base + '/api/state')).json());
    expect(stateText).not.toContain('gen-pw-shown-once-12345');
  });

  it('returns 409 with a reason when advancing past a failed check', async () => {
    const base = await start(testServer({ actions: fakeActions({ checkDocker: async () => ({ dockerAvailable: false, dockerComposeAvailable: false }) }) }));
    const post = (p: string, body?: unknown) =>
      fetch(base + p, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    await post('/api/config', FULL_CONFIG);
    await post('/api/advance'); // -> docker
    await post('/api/check/docker'); // records a failing result
    const res = await post('/api/advance');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Docker/i);
  });

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
    const res = await fetch(base + '/api/manager/update-check');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updateAvailable: boolean; latestVersion: string };
    expect(body.updateAvailable).toBe(true);
    expect(body.latestVersion).toBe('0.2.0');

    // Without a wired action the route is simply absent.
    const bare = await start(testServer({ actions: fakeActions(), port: 0 }));
    expect((await fetch(bare + '/api/manager/update-check')).status).toBe(404);
  });

  it('includes the manager version in every state snapshot', async () => {
    const base = await start(testServer({ actions: fakeActions(), managerVersion: '1.0.6' }));
    const body = (await (await fetch(base + '/api/state')).json()) as { managerVersion?: string };
    expect(body.managerVersion).toBe('1.0.6');
  });

  it('lists registry versions server-authoritatively (URL from wizard state, channel previewable)', async () => {
    const calls: { url: string; channel: string }[] = [];
    const base = await start(
      testServer({
        actions: fakeActions({
          listVersions: async (registryUrl, channel) => {
            calls.push({ url: registryUrl, channel });
            return { versions: ['0.2.0', '0.1.0'] };
          },
        }),
        initialConfig: { registryUrl: 'https://registry.example.com/' },
      }),
    );

    const res = await fetch(base + '/api/registry/versions');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { versions: string[] }).versions).toEqual(['0.2.0', '0.1.0']);
    // The registry URL comes from the server's wizard state, never the browser.
    expect(calls[0]).toEqual({ url: 'https://registry.example.com/', channel: 'stable' });

    await fetch(base + '/api/registry/versions?channel=beta');
    expect(calls[1]?.channel).toBe('beta');

    // Without a wired action the route is simply absent.
    const bare = await start(testServer({ actions: fakeActions(), port: 0 }));
    expect((await fetch(bare + '/api/registry/versions')).status).toBe(404);
  });

  it('re-runs after a failed install acknowledge import/repair (retry path)', async () => {
    const seenAllowImport: (boolean | undefined)[] = [];
    let failNext = true;
    const base = await start(
      testServer({
        actions: fakeActions({
          runInstall: async (plan) => {
            seenAllowImport.push(plan.serverInit.allowImport);
            if (failNext) {
              failNext = false;
              return { ok: false, detail: 'Provisioning failed at "wait_db": boom', failedStep: 'wait_db' };
            }
            return { ok: true, instanceDir: '/opt/selfhelp/instances/clinic-a', version: '0.1.0' };
          },
        }),
      }),
    );
    const post = (p: string, body?: unknown) =>
      fetch(base + p, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

    await post('/api/config', FULL_CONFIG);
    const order = ['welcome', 'docker', 'internet', 'registry', 'install_root', 'resources', 'mode', 'domain', 'proxy', 'instance', 'admin'];
    for (const step of order) {
      if (['docker', 'internet', 'registry', 'resources'].includes(step)) await post('/api/check/' + step);
      await post('/api/advance');
    }

    // First attempt: a fresh bootstrap — no import acknowledgement.
    const first = await snap(await post('/api/install'));
    expect(first.outcome?.ok).toBe(false);
    expect(seenAllowImport[0]).toBeUndefined();

    // Retry: the failed first attempt may have half-bootstrapped the server,
    // so the re-run must acknowledge import/repair instead of refusing.
    const second = await snap(await post('/api/install'));
    expect(second.outcome?.ok).toBe(true);
    expect(seenAllowImport[1]).toBe(true);
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
    const base = await start(testServer({ actions: fakeActions(), mode: 'persistent', operatorStore: store }));
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

  async function managementBase(tmpRoot: string): Promise<{ base: string; cookie: string; csrfToken: string }> {
    const created = createOperator(emptyOperatorTable(), {
      email: 'owner@example.com',
      displayName: 'Owner',
      password: 'correct horse battery staple',
      roles: ['server_owner'],
    });
    const store = new InMemoryOperatorStore(created.table);
    const journal = new OperationJournal(tmpRoot);
    const runner = new OperationRunner(journal, new AuditLog(tmpRoot), new InstanceLocks(tmpRoot));
    const base = await start(
      testServer({
        actions: fakeActions(),
        mode: 'persistent',
        operatorStore: store,
        instanceManagement: { instances: fakeInstanceActions(), runner, journal },
      }),
    );
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery staple' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    return { base, cookie, csrfToken };
  }

  it('never exposes instance APIs in bootstrap mode', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const journal = new OperationJournal(tmpRoot);
      const runner = new OperationRunner(journal, new AuditLog(tmpRoot), new InstanceLocks(tmpRoot));
      const base = await start(
        testServer({
          actions: fakeActions(),
          mode: 'bootstrap',
          instanceManagement: { instances: fakeInstanceActions(), runner, journal },
        }),
      );
      const res = await fetch(base + '/api/instances');
      expect(res.status).toBe(404);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

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

  it('validates create requests before starting an operation', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const res = await fetch(base + '/api/instances', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken },
        body: JSON.stringify({ instanceId: 'x' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
