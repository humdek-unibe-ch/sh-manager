// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  InstanceLockedError,
  InstanceLocks,
  OperationJournal,
  OperationRunner,
} from './jobs.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-jobs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('OperationJournal', () => {
  it('creates, logs, phases and completes an operation as one polled JSON record', async () => {
    const journal = new OperationJournal(root);
    const record = await journal.create('instance_backup', 'clinic-a');
    expect(record.status).toBe('running');

    await journal.setPhase(record.id, 'backup');
    await journal.append(record.id, 'dumping database');
    await journal.complete(record.id, { backupId: 'backup-1' });

    const read = await journal.get(record.id);
    expect(read?.status).toBe('succeeded');
    expect(read?.phase).toBe('done');
    expect(read?.finishedAt).not.toBeNull();
    expect(read?.log.some((l) => l.includes('dumping database'))).toBe(true);
    expect(read?.result).toEqual({ backupId: 'backup-1' });
  });

  it('redacts secrets from log lines, results and errors before they touch disk', async () => {
    const journal = new OperationJournal(root);
    const record = await journal.create('instance_update', 'clinic-a');

    await journal.append(record.id, 'DATABASE_URL=mysql://selfhelp:super-secret@mysql:3306/app');
    await journal.complete(record.id, { adminPassword: 'hunter2', instanceDir: '/opt/x' });

    const raw = await readFile(path.join(root, 'manager', 'operations', `${record.id}.json`), 'utf8');
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('***REDACTED***');
    expect(raw).toContain('/opt/x');
  });

  it('lists newest-first and filters by instance', async () => {
    const journal = new OperationJournal(root);
    const a = await journal.create('instance_backup', 'clinic-a');
    const b = await journal.create('instance_update', 'clinic-b');
    await journal.complete(a.id, null);
    await journal.fail(b.id, new Error('boom'));

    const all = await journal.list();
    expect(all.length).toBe(2);
    const onlyB = await journal.list({ instanceId: 'clinic-b' });
    expect(onlyB.map((r) => r.id)).toEqual([b.id]);
    expect(onlyB[0]?.status).toBe('failed');
    expect(onlyB[0]?.error).toContain('boom');
  });

  it('returns null for an unknown operation and never resolves path-like ids', async () => {
    const journal = new OperationJournal(root);
    expect(await journal.get('op-never-created')).toBeNull();
    // Path traversal never reaches the filesystem: the id gate throws inside
    // get(), which surfaces as a plain "not found".
    expect(await journal.get('../escape')).toBeNull();
    await expect(journal.append('../escape', 'x')).rejects.toThrow(/Invalid operation id/);
  });
});

describe('AuditLog', () => {
  it('appends JSONL entries and tails newest-first', async () => {
    const audit = new AuditLog(root);
    await audit.record({ operator: 'a@x', action: 'instance_backup', instanceId: 'i1', operationId: 'op1', sourceIp: '127.0.0.1', result: 'started' });
    await audit.record({ operator: 'a@x', action: 'instance_backup', instanceId: 'i1', operationId: 'op1', sourceIp: '127.0.0.1', result: 'succeeded' });

    const entries = await audit.tail();
    expect(entries.length).toBe(2);
    expect(entries[0]?.result).toBe('succeeded');
    expect(entries[1]?.result).toBe('started');
    expect(entries[0]?.at).toBeTruthy();
  });

  it('never writes secret values into the audit trail', async () => {
    const audit = new AuditLog(root);
    await audit.record({
      operator: 'a@x',
      action: 'instance_create',
      instanceId: 'i1',
      operationId: 'op1',
      sourceIp: null,
      result: 'failed',
      detail: 'install failed: mysql://root:topsecret@mysql:3306 rejected',
    });
    const raw = await readFile(path.join(root, 'manager', 'audit.jsonl'), 'utf8');
    expect(raw).not.toContain('topsecret');
  });
});

describe('InstanceLocks', () => {
  it('allows one holder per instance and reports the conflict holder', async () => {
    const locks = new InstanceLocks(root);
    const lock = await locks.acquire('clinic-a', 'op-1');

    await expect(locks.acquire('clinic-a', 'op-2')).rejects.toBeInstanceOf(InstanceLockedError);
    // A different instance is unaffected.
    const other = await locks.acquire('clinic-b', 'op-3');
    await other.release();

    await lock.release();
    const after = await locks.acquire('clinic-a', 'op-4');
    await after.release();
  });

  it('steals a stale lock left by a dead process', async () => {
    const locks = new InstanceLocks(root);
    // Forge a lockfile owned by a pid that cannot be alive.
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = path.join(root, 'manager', 'locks');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'clinic-a.lock'), JSON.stringify({ operationId: 'op-dead', pid: 999999999, acquiredAt: '2026-01-01T00:00:00Z' }));

    const lock = await locks.acquire('clinic-a', 'op-new');
    const holder = await locks.holder('clinic-a');
    expect(holder?.operationId).toBe('op-new');
    await lock.release();
  });

  it('refuses invalid instance ids', async () => {
    const locks = new InstanceLocks(root);
    await expect(locks.acquire('../etc', 'op-1')).rejects.toThrow(/Invalid instance id/);
    // Uppercase is refused too: the CLI never produces it, and on a
    // case-insensitive filesystem "Clinic-A" would alias the "clinic-a" lock.
    await expect(locks.acquire('Clinic-A', 'op-1')).rejects.toThrow(/Invalid instance id/);
  });
});

describe('OperationRunner', () => {
  function makeRunner() {
    const journal = new OperationJournal(root);
    const audit = new AuditLog(root);
    const locks = new InstanceLocks(root);
    return { runner: new OperationRunner(journal, audit, locks), journal, audit, locks };
  }

  it('returns the operation id immediately and completes in the background (202 semantics)', async () => {
    const { runner, journal, audit } = makeRunner();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const { operationId, done } = await runner.start(
      { kind: 'instance_backup', instanceId: 'clinic-a', operator: 'ops@example.com', sourceIp: '127.0.0.1' },
      async (ctx) => {
        await ctx.setPhase('backup');
        await gate;
        return { backupId: 'b-1' };
      },
    );

    expect((await journal.get(operationId))?.status).toBe('running');
    release();
    await done;

    expect((await journal.get(operationId))?.status).toBe('succeeded');
    const entries = await audit.tail();
    expect(entries.map((e) => e.result)).toEqual(['succeeded', 'started']);
    expect(entries[0]?.operator).toBe('ops@example.com');
  });

  it('records failures in journal + audit and always releases the lock', async () => {
    const { runner, journal, locks } = makeRunner();
    const { operationId, done } = await runner.start(
      { kind: 'instance_update', instanceId: 'clinic-a', operator: 'ops@example.com', sourceIp: null },
      async () => {
        throw new Error('update exploded');
      },
    );
    await done;

    const record = await journal.get(operationId);
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('update exploded');
    expect(await locks.holder('clinic-a')).toBeNull();
  });

  it('denies a second mutating operation while the first holds the instance lock', async () => {
    const { runner, audit } = makeRunner();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const first = await runner.start(
      { kind: 'instance_update', instanceId: 'clinic-a', operator: 'a@x', sourceIp: null },
      async () => gate,
    );

    await expect(
      runner.start({ kind: 'instance_backup', instanceId: 'clinic-a', operator: 'b@x', sourceIp: null }, async () => null),
    ).rejects.toBeInstanceOf(InstanceLockedError);

    const denied = (await audit.tail()).find((e) => e.result === 'denied');
    expect(denied?.operator).toBe('b@x');

    release();
    await first.done;
  });
});
