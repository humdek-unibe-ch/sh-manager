// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * BackupSchedulerLoop tests: due backups run journaled through the
 * OperationRunner, idle ticks stay silent, and the per-instance lock
 * serializes the scheduler against GUI actions and the CMS/plugin drain.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, InstanceLocks, OperationJournal, OperationRunner } from './jobs.js';
import { BackupSchedulerLoop } from './backup-scheduler.js';
import { CmsOperationsPoller } from './poller.js';
import type { InstanceSummary, ManagerInstanceActions } from './instances.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-bsched-'));
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
  due: Record<string, boolean>;
  ran: string[];
  dueError?: Error;
  runError?: Error;
  /** Set true to make the CMS poller see pending work (lock-interaction test). */
  cmsPending?: Record<string, boolean>;
  drained?: string[];
  /** Optional gate awaited inside runScheduledBackup (to hold the lock open). */
  runGate?: Promise<void>;
}

function fakeInstances(b: FakeBehaviour): ManagerInstanceActions {
  const unsupported = () => Promise.reject(new Error('not used by the scheduler'));
  return {
    list: async () => b.summaries,
    detail: unsupported,
    backups: unsupported,
    livePlugins: unsupported,
    health: unsupported,
    serverStatus: unsupported,
    mailer: unsupported,
    envConfig: unsupported,
    logs: unsupported,
    proxyLogs: unsupported,
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
    setName: unsupported,
    setEnv: unsupported,
    disable: unsupported,
    enable: unsupported,
    remove: unsupported,
    backupSchedule: unsupported,
    setBackupSchedule: unsupported,
    backupPrunePlan: unsupported,
    backupPrune: unsupported,
    async peekPendingCmsWork(id) {
      return { systemUpdate: null, pluginOps: b.cmsPending?.[id] ?? false };
    },
    async drainCmsOperations(id, ctx) {
      (b.drained ??= []).push(id);
      await ctx.log(`drained ${id}`);
      return { processed: 1, outcomes: ['ok'] };
    },
    async hasDueScheduledBackup(id) {
      if (b.dueError) throw b.dueError;
      return b.due[id] ?? false;
    },
    async runScheduledBackup(id, ctx) {
      if (b.runGate) await b.runGate;
      if (b.runError) throw b.runError;
      b.ran.push(id);
      await ctx.log(`scheduled backup for ${id}`);
      return { instanceId: id, action: 'backup_taken', backupId: `backup-20260612-${id}-001`, prunedCount: 1 };
    },
  };
}

function makeLoop(b: FakeBehaviour, log: string[] = []) {
  const journal = new OperationJournal(root);
  const locks = new InstanceLocks(root);
  const runner = new OperationRunner(journal, new AuditLog(root), locks);
  const loop = new BackupSchedulerLoop({
    instances: fakeInstances(b),
    runner,
    intervalMs: 1_000_000, // ticks are driven manually in tests
    log: (line) => log.push(line),
  });
  return { loop, journal, locks, runner, instances: fakeInstances(b) };
}

describe('BackupSchedulerLoop', () => {
  it('runs a due scheduled backup through the journaled runner', async () => {
    const b: FakeBehaviour = { summaries: [summary()], due: { 'clinic-a': true }, ran: [] };
    const { loop, journal } = makeLoop(b);

    await loop.tick();

    expect(b.ran).toEqual(['clinic-a']);
    const ops = await journal.list({ instanceId: 'clinic-a' });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe('instance_scheduled_backup');
    expect(ops[0]?.status).toBe('succeeded');
    expect(ops[0]?.log.some((l) => l.includes('scheduled backup for clinic-a'))).toBe(true);
  });

  it('creates no journal rows on idle ticks (nothing due)', async () => {
    const b: FakeBehaviour = { summaries: [summary()], due: {}, ran: [] };
    const { loop, journal } = makeLoop(b);

    await loop.tick();
    await loop.tick();

    expect(b.ran).toEqual([]);
    expect(await journal.list()).toEqual([]);
  });

  it('skips disabled, broken and busy instances', async () => {
    const b: FakeBehaviour = {
      summaries: [
        summary({ instanceId: 'disabled-x', status: 'disabled' }),
        summary({ instanceId: 'broken-y', status: 'broken', brokenReason: 'manifest missing' }),
        summary({ instanceId: 'busy-z', busy: { operationId: 'op-elsewhere', acquiredAt: 'now' } }),
      ],
      due: { 'disabled-x': true, 'broken-y': true, 'busy-z': true },
      ran: [],
    };
    const { loop } = makeLoop(b);

    await loop.tick();

    expect(b.ran).toEqual([]);
  });

  it('never runs concurrently with a GUI action or the CMS/plugin drain on one instance (shared lock)', async () => {
    const b: FakeBehaviour = { summaries: [summary()], due: { 'clinic-a': true }, ran: [] };
    const { loop, locks } = makeLoop(b);

    // A GUI action / plugin drain holds the per-instance lock.
    const held = await locks.acquire('clinic-a', 'op-gui-or-drain');
    await loop.tick();
    expect(b.ran).toEqual([]); // scheduler backed off

    await held.release();
    await loop.tick();
    expect(b.ran).toEqual(['clinic-a']); // next tick catches up
  });

  it('blocks the CMS/plugin drain while a scheduled backup holds the lock (other direction)', async () => {
    // The scheduler's backup is in flight (holds the lock via the runner)...
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    const b: FakeBehaviour = {
      summaries: [summary()],
      due: { 'clinic-a': true },
      ran: [],
      cmsPending: { 'clinic-a': true },
      drained: [],
      runGate: gate,
    };
    const journal = new OperationJournal(root);
    const locks = new InstanceLocks(root);
    const runner = new OperationRunner(journal, new AuditLog(root), locks);
    const instances = fakeInstances(b);
    const loop = new BackupSchedulerLoop({ instances, runner, intervalMs: 1_000_000, log: () => undefined });
    const poller = new CmsOperationsPoller({ instances, runner, intervalMs: 1_000_000, log: () => undefined });

    const backupTick = loop.tick(); // holds the clinic-a lock until the gate opens
    await new Promise((r) => setTimeout(r, 20)); // let the runner acquire the lock

    // ...so the CMS poller cannot drain the same instance concurrently.
    await poller.tick();
    expect(b.drained).toEqual([]);

    releaseGate();
    await backupTick;
    expect(b.ran).toEqual(['clinic-a']);

    // Lock free again: the drain goes through on the next tick.
    await poller.tick();
    expect(b.drained).toEqual(['clinic-a']);
  });

  it('journals a failed scheduled backup as failed', async () => {
    const b: FakeBehaviour = {
      summaries: [summary()],
      due: { 'clinic-a': true },
      ran: [],
      runError: new Error('mysqldump exited with code 1'),
    };
    const { loop, journal } = makeLoop(b);

    await loop.tick();

    const ops = await journal.list({ instanceId: 'clinic-a' });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.status).toBe('failed');
    expect(ops[0]?.error).toContain('mysqldump');
  });

  it('logs a due-check failure once instead of every tick', async () => {
    const log: string[] = [];
    const b: FakeBehaviour = {
      summaries: [summary()],
      due: {},
      ran: [],
      dueError: new Error('manifest unreadable'),
    };
    const { loop } = makeLoop(b, log);

    await loop.tick();
    await loop.tick();
    await loop.tick();

    expect(log.filter((l) => l.includes('manifest unreadable'))).toHaveLength(1);
  });
});
