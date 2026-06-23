// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance management APIs (list / detail / health / logs / lifecycle / backup / operations) behind the BFF.
 *
 * Split out of the original monolithic `server.test.ts`; the shared BFF
 * harness (fake actions/stores, ephemeral test server, login, SPA dir +
 * cleanup) lives in `server-test-support`. The test bodies are unchanged.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BootstrapActions } from './actions.js';
import { AuditLog, InstanceLocks, OperationJournal, OperationRunner } from './jobs.js';
import type { ManagerInstanceActions } from './instances.js';
import { fakeActions, login, start, testServer } from './server-test-support.js';

describe('instance management APIs', () => {
  /** PUT /backup-schedule calls captured by the fake (asserted per test). */
  let setSchedules: { instanceId: string; policy: unknown }[] = [];
  beforeEach(() => {
    setSchedules = [];
  });

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
      async livePlugins() {
        return null;
      },
      async health() {
        return { instanceId: 'clinic-a', overall: 'healthy', services: [], checkedAt: '2026-06-01T00:00:00Z' };
      },
      async serverStatus() {
        return { initialized: true, serverId: 'srv-1', proxyNetwork: 'selfhelp-proxy', instanceCount: 1 };
      },
      async scanOrphans(id) {
        // 'ghost' models a removed-but-not-fully-deleted id; everything else clean.
        if (id === 'ghost') {
          return { instanceId: id, registered: false, volumes: ['selfhelp_ghost_mysql_data'], hasDirectory: false, hasOrphans: true };
        }
        return { instanceId: id, registered: id === 'clinic-a', volumes: [], hasDirectory: false, hasOrphans: false };
      },
      async cleanupOrphans(id) {
        if (id === 'clinic-a') throw new Error(`"${id}" is a registered instance — refusing to delete its data here.`);
        return { removedVolumes: ['selfhelp_ghost_mysql_data'], removedDirectory: false };
      },
      async mailer(id) {
        if (id !== 'clinic-a') throw new Error('not found');
        return { configured: true, redactedDsn: 'smtp://mailer:***@mail.example.org:587' };
      },
      async envConfig(id) {
        return {
          instanceId: id,
          managedKeys: ['SELFHELP_INSTANCE_ID'],
          entries: [
            { key: 'JWT_TOKEN_TTL', value: '3600', defaultValue: '3600', managed: false, custom: false, overridden: false },
            { key: 'SELFHELP_INSTANCE_ID', value: id, defaultValue: id, managed: true, custom: false, overridden: false },
          ],
        };
      },
      async logs(id, opts) {
        return {
          instanceId: id,
          service: opts.service ?? 'backend',
          tail: opts.tail ?? 200,
          text: `[${opts.service ?? 'backend'}] sample log line\n`,
          readAt: '2026-06-01T12:00:00.000Z',
        };
      },
      async proxyLogs(opts) {
        return {
          tail: opts.tail ?? 200,
          text: 'traefik  | level=info msg="Configuration loaded"\n',
          readAt: '2026-06-01T12:00:00.000Z',
        };
      },
      async updateDryRun() {
        return { status: 'update_available' };
      },
      async frontendUpdateDryRun() {
        return { status: 'ok', kind: 'frontend', currentFrontendVersion: '0.1.5', targetFrontendVersion: '0.1.7' };
      },
      async mobilePreviewUpdateDryRun() {
        return {
          status: 'ok',
          kind: 'mobile-preview',
          currentMobilePreviewVersion: '0.2.0',
          targetMobilePreviewVersion: '0.2.3',
          pluginGate: null,
        };
      },
      async create() {
        return { version: '0.1.0' };
      },
      async update() {
        return { executed: true };
      },
      async frontendUpdate() {
        return { executed: true };
      },
      async mobilePreviewUpdate() {
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
      async setName(_id, req) {
        return { changed: true, previousName: 'Old', displayName: req.displayName };
      },
      async setEnv(_id, req) {
        return { applied: Object.keys(req.overrides).length, restarted: true, health: null };
      },
      async remove() {
        return { executed: true };
      },
      async disable() {
        return { executed: true };
      },
      async enable() {
        return { executed: true, recreated: false, health: null };
      },
      async safeMode(_id, req) {
        return { enabled: req.enable };
      },
      async pluginRecover() {
        return { steps: ['recovered'], drained: [], recovered: true, safeModeLeftEnabled: false };
      },
      async peekPendingCmsWork() {
        return { systemUpdate: null, pluginOps: false };
      },
      async drainCmsOperations() {
        return { processed: 0, outcomes: [] };
      },
      async backupSchedule(id) {
        return {
          instanceId: id,
          policy: { enabled: true, time: '02:00', retention: { daily: 7, weekly: 5, monthly: 12, maxAgeDays: 365 } },
          lastRunAt: null,
          lastResult: null,
          lastBackupId: null,
          lastDetail: null,
          nextRunAt: '2026-06-13T02:00:00.000Z',
          backups: { count: 2, totalBytes: 2048 },
          footprint: { slots: 24, averageBackupBytes: 1024, steadyStateBytes: 24576, requiredFreeBytes: 2048 },
        };
      },
      async setBackupSchedule(id, policy) {
        setSchedules.push({ instanceId: id, policy });
        return { ...(await this.backupSchedule(id)), policy };
      },
      async backupPrunePlan() {
        return {
          plan: {
            keep: [{ backupId: 'backup-20260612-clinic-a-001', origin: 'scheduled', createdAt: '2026-06-12T02:00:00Z', action: 'keep', reasons: ['daily'] }],
            prune: [{ backupId: 'backup-20250101-clinic-a-001', origin: 'scheduled', createdAt: '2025-01-01T02:00:00Z', action: 'prune', reasons: ['older-than-max-age'] }],
          },
          deleted: [],
          skipped: [],
          dryRun: true,
        };
      },
      async backupPrune() {
        return { deleted: ['backup-20250101-clinic-a-001'], kept: 1 };
      },
      async hasDueScheduledBackup() {
        return false;
      },
      async runScheduledBackup(id) {
        return { instanceId: id, action: 'backup_taken', backupId: 'backup-20260612-clinic-a-002' };
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

  it('scans and cleans orphaned resources for a not-registered id (CSRF-guarded)', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const authed = { cookie };
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };

      // Read scan needs auth, works for an id that is not a live instance.
      expect((await fetch(base + '/api/instances/ghost/orphans')).status).toBe(401);
      const scan = await fetch(base + '/api/instances/ghost/orphans', { headers: authed });
      expect(scan.status).toBe(200);
      const report = (await scan.json()) as { hasOrphans: boolean; volumes: string[] };
      expect(report.hasOrphans).toBe(true);
      expect(report.volumes).toContain('selfhelp_ghost_mysql_data');

      // Cleanup is state-changing, so CSRF is required (same guard as remove).
      const noCsrf = await fetch(base + '/api/instances/ghost/orphans/cleanup', { method: 'POST', headers: { cookie } });
      expect(noCsrf.status).toBe(403);

      const cleanup = await fetch(base + '/api/instances/ghost/orphans/cleanup', { method: 'POST', headers: mutating });
      expect(cleanup.status).toBe(200);
      const result = (await cleanup.json()) as { removedVolumes: string[] };
      expect(result.removedVolumes).toContain('selfhelp_ghost_mysql_data');
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

  it('disables and re-enables an instance under their own journaled operation kinds', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const authed = { cookie };
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };

      // State-changing, so CSRF is required (same guard as remove).
      const noCsrf = await fetch(base + '/api/instances/clinic-a/disable', { method: 'POST', headers: { cookie } });
      expect(noCsrf.status).toBe(403);

      const drive = async (path: string, expectedKind: string): Promise<void> => {
        const accepted = await fetch(base + path, { method: 'POST', headers: mutating });
        expect(accepted.status).toBe(202);
        const { operationId } = (await accepted.json()) as { operationId: string };
        let status = 'running';
        let kind = '';
        for (let i = 0; i < 50 && status === 'running'; i++) {
          const op = await fetch(`${base}/api/operations/${operationId}`, { headers: authed });
          const body = (await op.json()) as { status: string; kind: string };
          status = body.status;
          kind = body.kind;
          if (status === 'running') await new Promise((r) => setTimeout(r, 10));
        }
        expect(status).toBe('succeeded');
        expect(kind).toBe(expectedKind);
      };

      // Disable journals as instance_disable, NOT instance_remove — so the
      // operator's history reads "instance disable", not a removal.
      await drive('/api/instances/clinic-a/disable', 'instance_disable');
      // Enable is its own inverse operation.
      await drive('/api/instances/clinic-a/enable', 'instance_enable');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('toggles safe mode and recovers plugins under their own journaled operation kinds', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const authed = { cookie };
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };

      // State-changing, so CSRF is required.
      const noCsrf = await fetch(base + '/api/instances/clinic-a/safe-mode', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: true }),
      });
      expect(noCsrf.status).toBe(403);

      // `enable` is mandatory and must be a boolean.
      const bad = await fetch(base + '/api/instances/clinic-a/safe-mode', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);

      const driveBody = async (path: string, body: unknown, expectedKind: string): Promise<void> => {
        const accepted = await fetch(base + path, { method: 'POST', headers: mutating, body: JSON.stringify(body) });
        expect(accepted.status).toBe(202);
        const { operationId } = (await accepted.json()) as { operationId: string };
        let status = 'running';
        let kind = '';
        for (let i = 0; i < 50 && status === 'running'; i++) {
          const op = await fetch(`${base}/api/operations/${operationId}`, { headers: authed });
          const opBody = (await op.json()) as { status: string; kind: string };
          status = opBody.status;
          kind = opBody.kind;
          if (status === 'running') await new Promise((r) => setTimeout(r, 10));
        }
        expect(status).toBe('succeeded');
        expect(kind).toBe(expectedKind);
      };

      // Safe mode carries an explicit direction and journals as instance_safe_mode.
      await driveBody('/api/instances/clinic-a/safe-mode', { enable: true }, 'instance_safe_mode');
      // Plugin recover takes no body and journals as instance_plugin_recover.
      await driveBody('/api/instances/clinic-a/plugin-recover', undefined, 'instance_plugin_recover');
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

  it('reads and sets the backup schedule (server-side validation) and serves the prune preview', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };

      const get = await fetch(base + '/api/instances/clinic-a/backup-schedule', { headers: { cookie } });
      expect(get.status).toBe(200);
      const status = (await get.json()) as { policy: { time: string }; footprint: { steadyStateBytes: number } };
      expect(status.policy.time).toBe('02:00');
      expect(status.footprint.steadyStateBytes).toBeGreaterThan(0);

      // Malformed policies are rejected with the exact problems (server-authoritative).
      const bad = await fetch(base + '/api/instances/clinic-a/backup-schedule', {
        method: 'PUT',
        headers: mutating,
        body: JSON.stringify({ enabled: true, time: '24:00', retention: { daily: 0, weekly: 5, monthly: 12, maxAgeDays: 365 } }),
      });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { error: string };
      expect(badBody.error).toMatch(/HH:MM/);
      expect(badBody.error).toMatch(/retention\.daily/);
      expect(setSchedules).toHaveLength(0);

      // CSRF applies to the schedule write too.
      const noCsrf = await fetch(base + '/api/instances/clinic-a/backup-schedule', {
        method: 'PUT',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, time: '03:30', retention: { daily: 7, weekly: 5, monthly: 12, maxAgeDays: 365 } }),
      });
      expect(noCsrf.status).toBe(403);

      const ok = await fetch(base + '/api/instances/clinic-a/backup-schedule', {
        method: 'PUT',
        headers: mutating,
        body: JSON.stringify({ enabled: true, time: '03:30', retention: { daily: 7, weekly: 5, monthly: 12, maxAgeDays: 365 } }),
      });
      expect(ok.status).toBe(200);
      expect(setSchedules).toHaveLength(1);
      expect((setSchedules[0]!.policy as { time: string }).time).toBe('03:30');

      // Dry-run prune answers synchronously and deletes nothing.
      const dry = await fetch(base + '/api/instances/clinic-a/backup-prune', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ dryRun: true }),
      });
      expect(dry.status).toBe(200);
      const dryBody = (await dry.json()) as { dryRun: boolean; deleted: string[]; plan: { prune: unknown[] } };
      expect(dryBody.dryRun).toBe(true);
      expect(dryBody.deleted).toHaveLength(0);
      expect(dryBody.plan.prune).toHaveLength(1);

      // The real prune runs as a journaled 202 operation.
      const prune = await fetch(base + '/api/instances/clinic-a/backup-prune', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({}),
      });
      expect(prune.status).toBe(202);
      const { operationId } = (await prune.json()) as { operationId: string };
      expect(await waitForOperation(base, cookie, operationId)).toBe('succeeded');
      const op = await fetch(`${base}/api/operations/${operationId}`, { headers: { cookie } });
      expect(((await op.json()) as { kind: string }).kind).toBe('instance_backup_prune');
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

  it('renames an instance display name (rejecting an empty name)', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };

      // An empty / whitespace-only name is rejected before any operation starts.
      const bad = await fetch(base + '/api/instances/clinic-a/name', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ displayName: '   ' }),
      });
      expect(bad.status).toBe(400);

      const ok = await fetch(base + '/api/instances/clinic-a/name', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ displayName: 'Renamed Clinic' }),
      });
      expect(ok.status).toBe(202);
      const { operationId } = (await ok.json()) as { operationId: string };
      expect(await waitForOperation(base, cookie, operationId)).toBe('succeeded');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('reads and sets instance env overrides (rejecting non-object payloads)', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };

      const get = await fetch(base + '/api/instances/clinic-a/env', { headers: { cookie } });
      expect(get.status).toBe(200);
      const env = (await get.json()) as { entries: { key: string; managed: boolean }[]; managedKeys: string[] };
      expect(env.entries.some((e) => e.key === 'JWT_TOKEN_TTL' && !e.managed)).toBe(true);
      expect(env.managedKeys).toContain('SELFHELP_INSTANCE_ID');

      // A non-object `overrides` is rejected before any operation starts.
      const bad = await fetch(base + '/api/instances/clinic-a/env', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ overrides: 'nope' }),
      });
      expect(bad.status).toBe(400);

      const ok = await fetch(base + '/api/instances/clinic-a/env', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ overrides: { JWT_TOKEN_TTL: '7200' } }),
      });
      expect(ok.status).toBe(202);
      const { operationId } = (await ok.json()) as { operationId: string };
      expect(await waitForOperation(base, cookie, operationId)).toBe('succeeded');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('reads instance logs for a service and rejects an unknown service', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie } = await managementBase(tmpRoot);

      const ok = await fetch(base + '/api/instances/clinic-a/logs?service=backend&tail=50', { headers: { cookie } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { service: string; tail: number; text: string };
      expect(body.service).toBe('backend');
      expect(body.tail).toBe(50);
      expect(body.text).toContain('sample log line');

      // An unknown service is rejected at the BFF (clean 400, never a 500).
      const bad = await fetch(base + '/api/instances/clinic-a/logs?service=bogus', { headers: { cookie } });
      expect(bad.status).toBe(400);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('reads the shared reverse-proxy (Traefik) logs and rejects a non-numeric tail', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie } = await managementBase(tmpRoot);

      const ok = await fetch(base + '/api/server/proxy-logs?tail=50', { headers: { cookie } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { tail: number; text: string };
      expect(body.tail).toBe(50);
      expect(body.text).toContain('Configuration loaded');

      // A non-numeric tail is rejected at the BFF (clean 400, never a 500).
      const bad = await fetch(base + '/api/server/proxy-logs?tail=abc', { headers: { cookie } });
      expect(bad.status).toBe(400);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('previews and starts a frontend-only update via the dedicated routes', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-mgmt-'));
    try {
      const { base, cookie, csrfToken } = await managementBase(tmpRoot);
      const mutating = { cookie, 'Content-Type': 'application/json', 'x-shm-csrf': csrfToken };

      // Dry-run is a pure read: it returns the resolved frontend-only plan.
      const dry = await fetch(base + '/api/instances/clinic-a/frontend-update/dry-run', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({}),
      });
      expect(dry.status).toBe(200);
      const { plan } = (await dry.json()) as { plan: { kind: string; targetFrontendVersion: string } };
      expect(plan.kind).toBe('frontend');
      expect(plan.targetFrontendVersion).toBe('0.1.7');

      // Execution goes through the journaled job layer (202 + operation id).
      const exec = await fetch(base + '/api/instances/clinic-a/frontend-update', {
        method: 'POST',
        headers: mutating,
        body: JSON.stringify({ target: '0.1.7' }),
      });
      expect(exec.status).toBe(202);
      const { operationId } = (await exec.json()) as { operationId: string };
      expect(await waitForOperation(base, cookie, operationId)).toBe('succeeded');
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
