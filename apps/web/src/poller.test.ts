// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, InstanceLocks, OperationJournal, OperationRunner } from './jobs.js';
import { CmsOperationsPoller } from './poller.js';
import type { InstanceSummary, ManagerInstanceActions } from './instances.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-poller-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function summary(overrides: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    instanceId: 'clinic-a',
    displayName: 'Clinic A',
    domain: 'a.example.com',
    mode: 'production',
    status: 'active',
    version: '0.1.0',
    updatedAt: null,
    brokenReason: null,
    busy: null,
    ...overrides,
  };
}

interface FakeBehaviour {
  summaries: InstanceSummary[];
  pending: Record<string, boolean>;
  drained: string[];
  pendingError?: Error;
}

function fakeInstances(b: FakeBehaviour): ManagerInstanceActions {
  const unsupported = () => Promise.reject(new Error('not used by the poller'));
  return {
    list: async () => b.summaries,
    detail: unsupported,
    backups: unsupported,
    health: unsupported,
    serverStatus: unsupported,
    mailer: unsupported,
    envConfig: unsupported,
    updateDryRun: unsupported,
    frontendUpdateDryRun: unsupported,
    create: unsupported,
    update: unsupported,
    frontendUpdate: unsupported,
    backup: unsupported,
    restore: unsupported,
    clone: unsupported,
    setAddress: unsupported,
    setMailer: unsupported,
    setEnv: unsupported,
    remove: unsupported,
    async hasPendingCmsOperation(id) {
      if (b.pendingError) throw b.pendingError;
      return b.pending[id] ?? false;
    },
    async drainCmsOperations(id, ctx) {
      b.drained.push(id);
      await ctx.log(`drained ${id}`);
      return { processed: 1, outcomes: [`Operation op_1 finished: succeeded.`] };
    },
    backupSchedule: unsupported,
    setBackupSchedule: unsupported,
    backupPrunePlan: unsupported,
    backupPrune: unsupported,
    hasDueScheduledBackup: async () => false,
    runScheduledBackup: unsupported,
  };
}

function makePoller(b: FakeBehaviour, log: string[] = []) {
  const journal = new OperationJournal(root);
  const locks = new InstanceLocks(root);
  const runner = new OperationRunner(journal, new AuditLog(root), locks);
  const poller = new CmsOperationsPoller({
    instances: fakeInstances(b),
    runner,
    intervalMs: 1_000_000, // ticks are driven manually in tests
    log: (line) => log.push(line),
  });
  return { poller, journal, locks };
}

describe('CmsOperationsPoller', () => {
  it('drains instances with pending CMS operations and journals the run', async () => {
    const b: FakeBehaviour = { summaries: [summary()], pending: { 'clinic-a': true }, drained: [] };
    const { poller, journal } = makePoller(b);

    await poller.tick();

    expect(b.drained).toEqual(['clinic-a']);
    const ops = await journal.list({ instanceId: 'clinic-a' });
    expect(ops.length).toBe(1);
    expect(ops[0]?.kind).toBe('cms_operations_drain');
    expect(ops[0]?.status).toBe('succeeded');
    expect(ops[0]?.log.some((l) => l.includes('drained clinic-a'))).toBe(true);
  });

  it('does not create journal noise for idle instances', async () => {
    const b: FakeBehaviour = { summaries: [summary()], pending: {}, drained: [] };
    const { poller, journal } = makePoller(b);

    await poller.tick();

    expect(b.drained).toEqual([]);
    expect(await journal.list()).toEqual([]);
  });

  it('skips disabled, broken and busy instances', async () => {
    const b: FakeBehaviour = {
      summaries: [
        summary({ instanceId: 'disabled-x', status: 'disabled' }),
        summary({ instanceId: 'broken-y', status: 'broken', brokenReason: 'manifest missing' }),
        summary({ instanceId: 'busy-z', busy: { operationId: 'op-elsewhere', acquiredAt: 'now' } }),
      ],
      pending: { 'disabled-x': true, 'broken-y': true, 'busy-z': true },
      drained: [],
    };
    const { poller } = makePoller(b);

    await poller.tick();

    expect(b.drained).toEqual([]);
  });

  it('respects the per-instance lock (GUI action in flight wins)', async () => {
    const b: FakeBehaviour = { summaries: [summary()], pending: { 'clinic-a': true }, drained: [] };
    const { poller, locks } = makePoller(b);
    const held = await locks.acquire('clinic-a', 'op-gui-action');

    // The summary still says "not busy" (fake), but the lock refuses the drain.
    await poller.tick();
    expect(b.drained).toEqual([]);

    await held.release();
    await poller.tick();
    expect(b.drained).toEqual(['clinic-a']);
  });

  it('logs a backend failure once instead of every tick', async () => {
    const log: string[] = [];
    const b: FakeBehaviour = {
      summaries: [summary()],
      pending: {},
      drained: [],
      pendingError: new Error('SELFHELP_MANAGER_TOKEN not set in the container'),
    };
    const { poller } = makePoller(b, log);

    await poller.tick();
    await poller.tick();
    await poller.tick();

    const failures = log.filter((l) => l.includes('SELFHELP_MANAGER_TOKEN'));
    expect(failures.length).toBe(1);
  });
});
