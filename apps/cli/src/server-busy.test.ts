// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeRunningOperation, findRunningOperations, operationsDir } from './server-busy.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-busy-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeOp(name: string, record: unknown): Promise<void> {
  const dir = operationsDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), JSON.stringify(record), 'utf8');
}

describe('findRunningOperations (self-update busy guard)', () => {
  it('returns only operations still marked running, oldest first', async () => {
    await writeOp('op-b.json', {
      id: 'op-b', kind: 'instance_update', instanceId: 'site2', phase: 'done', status: 'succeeded',
      startedAt: '2026-06-16T17:00:00.000Z',
    });
    await writeOp('op-a.json', {
      id: 'op-a', kind: 'cms_operations_drain', instanceId: 'site1', phase: 'composer', status: 'running',
      startedAt: '2026-06-16T18:00:00.000Z',
    });
    await writeOp('op-z.json', {
      id: 'op-z', kind: 'instance_backup', instanceId: 'site3', phase: 'x', status: 'running',
      startedAt: '2026-06-16T16:00:00.000Z',
    });
    await writeOp('op-c.json', {
      id: 'op-c', kind: 'instance_restore', instanceId: 'site4', phase: 'y', status: 'failed',
      startedAt: '2026-06-16T15:00:00.000Z',
    });

    const running = await findRunningOperations(root);
    expect(running.map((o) => o.id)).toEqual(['op-z', 'op-a']); // only running, oldest first
    expect(running[1]?.kind).toBe('cms_operations_drain');
    expect(running[1]?.instanceId).toBe('site1');
  });

  it('skips non-JSON and truncated files instead of throwing (a partial write must not block updates)', async () => {
    await writeOp('op-a.json', {
      id: 'op-a', kind: 'instance_update', instanceId: null, phase: 'p', status: 'running',
      startedAt: '2026-06-16T18:00:00.000Z',
    });
    const dir = operationsDir(root);
    await writeFile(path.join(dir, 'note.txt'), 'not an operation', 'utf8');
    await writeFile(path.join(dir, 'broken.json'), '{ truncated', 'utf8');

    const running = await findRunningOperations(root);
    expect(running.map((o) => o.id)).toEqual(['op-a']);
    expect(running[0]?.instanceId).toBeNull(); // server-level op
  });

  it('reports idle (empty) when the journal directory does not exist (offline / never-used GUI)', async () => {
    expect(await findRunningOperations(path.join(root, 'never'))).toEqual([]);
  });

  it('describes a running operation with scope and age', () => {
    const now = new Date('2026-06-16T18:30:00.000Z');
    const line = describeRunningOperation(
      { id: 'op-a', kind: 'cms_operations_drain', instanceId: 'site1', phase: 'composer', startedAt: '2026-06-16T18:00:00.000Z' },
      now,
    );
    expect(line).toContain('op-a');
    expect(line).toContain('cms_operations_drain');
    expect(line).toContain('instance site1');
    expect(line).toContain('30m');
  });

  it('describes server-scope operations and tolerates an unparseable timestamp', () => {
    const line = describeRunningOperation({
      id: 'op-s', kind: 'instance_create', instanceId: null, phase: '', startedAt: 'not-a-date',
    });
    expect(line).toContain('server');
    expect(line).not.toContain('NaN');
  });
});
