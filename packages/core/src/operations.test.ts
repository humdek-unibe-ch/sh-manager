// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from 'vitest';
import {
  processNextOperation,
  drainOperations,
  terminalStatus,
  type BackendOperationsClient,
  type OperationExecutor,
  type OperationLifecycleStatus,
  type OperationStatusUpdate,
  type PendingOperation,
  type PhaseReporter,
} from './operations.js';
import type { UpdateExecutionReport } from './update.js';

const TRUSTED = 'inst-a';

function op(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    operationId: 'op_1',
    instanceId: TRUSTED,
    targetVersion: '0.1.1',
    preflightId: 'pf_1',
    approvalToken: 'tok_1',
    approvedByUserId: 7,
    acceptedMigrationRisk: false,
    destructiveMigration: false,
    ...overrides,
  };
}

function recordingClient(pending: PendingOperation | null): {
  client: BackendOperationsClient;
  posts: OperationStatusUpdate[];
} {
  const posts: OperationStatusUpdate[] = [];
  const client: BackendOperationsClient = {
    fetchPending: async () => pending,
    postStatus: async (u) => {
      posts.push(u);
    },
  };
  return { client, posts };
}

function report(overrides: Partial<UpdateExecutionReport> = {}): UpdateExecutionReport {
  return {
    instanceId: TRUSTED,
    targetVersion: '0.1.1',
    ok: true,
    rolledBack: false,
    backupId: 'b1',
    steps: [
      { name: 'backup', status: 'done', detail: 'b1' },
      { name: 'health', status: 'done', detail: 'healthy' },
    ],
    ...overrides,
  };
}

/** Executor that streams the full granular phase sequence, then resolves. */
function phasingExecutor(result: UpdateExecutionReport): OperationExecutor {
  return async (_approved, _op, phase: PhaseReporter) => {
    await phase('preflight_running', 10);
    await phase('backup_running', 25, 'b1');
    await phase('update_running', 50);
    await phase('migration_running', 70);
    await phase('health_check_running', 90);
    return result;
  };
}

const statuses = (posts: OperationStatusUpdate[]): OperationLifecycleStatus[] => posts.map((p) => p.status);

describe('processNextOperation', () => {
  it('is a no-op when the backend has nothing pending', async () => {
    const { client, posts } = recordingClient(null);
    const execute = vi.fn();
    const outcome = await processNextOperation({ trustedInstanceId: TRUSTED, client, execute });
    expect(outcome).toEqual({ result: 'noop' });
    expect(execute).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it('consumes a pending request, streams progress, and writes back success', async () => {
    const { client, posts } = recordingClient(op());
    const execute = vi.fn(phasingExecutor(report({ ok: true })));

    const outcome = await processNextOperation({ trustedInstanceId: TRUSTED, client, execute });

    expect(execute).toHaveBeenCalledTimes(1);
    // The executor always receives the TRUSTED instance id, never a forged one.
    const approved = execute.mock.calls[0]![0];
    expect(approved.instanceId).toBe(TRUSTED);
    expect(approved.targetVersion).toBe('0.1.1');

    // Status progresses through the granular lifecycle and ends succeeded.
    expect(statuses(posts)).toEqual([
      'accepted',
      'preflight_running',
      'backup_running',
      'update_running',
      'migration_running',
      'health_check_running',
      'succeeded',
    ]);
    // Progress is monotonic and ends at 100.
    const progress = posts.map((p) => p.progressPercent);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(100);
    // Terminal write-back carries the executed steps.
    expect(posts.at(-1)?.steps?.length).toBe(2);
    expect(outcome).toMatchObject({ result: 'completed', status: 'succeeded', operationId: 'op_1' });
  });

  it('writes back a plain failure when the update fails before mutation', async () => {
    const { client, posts } = recordingClient(op());
    const execute = vi.fn(phasingExecutor(report({ ok: false, rolledBack: false, steps: [{ name: 'backup', status: 'failed' }] })));

    const outcome = await processNextOperation({ trustedInstanceId: TRUSTED, client, execute });

    expect(outcome).toMatchObject({ result: 'completed', status: 'failed' });
    expect(statuses(posts).at(-1)).toBe('failed');
  });

  it('writes back rolled_back when the update fails and rollback succeeds', async () => {
    const { client, posts } = recordingClient(op());
    const execute = vi.fn(
      phasingExecutor(
        report({ ok: false, rolledBack: true, steps: [{ name: 'health', status: 'failed' }, { name: 'rollback', status: 'done' }] }),
      ),
    );

    const outcome = await processNextOperation({ trustedInstanceId: TRUSTED, client, execute });

    expect(outcome).toMatchObject({ result: 'completed', status: 'rolled_back' });
    expect(statuses(posts).at(-1)).toBe('rolled_back');
  });

  it('writes back rollback_failed when both update and rollback fail', async () => {
    const { client, posts } = recordingClient(op());
    const execute = vi.fn(
      phasingExecutor(
        report({ ok: false, rolledBack: false, steps: [{ name: 'update', status: 'failed' }, { name: 'rollback', status: 'failed' }] }),
      ),
    );

    const outcome = await processNextOperation({ trustedInstanceId: TRUSTED, client, execute });

    expect(outcome).toMatchObject({ result: 'completed', status: 'rollback_failed' });
    expect(statuses(posts).at(-1)).toBe('rollback_failed');
  });

  it('rejects a cross-instance operation without executing it', async () => {
    // The backend returned an operation belonging to a DIFFERENT instance.
    const { client, posts } = recordingClient(op({ instanceId: 'inst-evil' }));
    const execute = vi.fn();

    const outcome = await processNextOperation({ trustedInstanceId: TRUSTED, client, execute });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ result: 'rejected', status: 'failed' });
    expect(outcome).toHaveProperty('reason', expect.stringContaining('Cross-instance'));
    expect(statuses(posts)).toEqual(['failed']);
  });

  it('rejects a destructive update that has no accepted migration risk', async () => {
    const { client, posts } = recordingClient(op({ destructiveMigration: true, acceptedMigrationRisk: false }));
    const execute = vi.fn();

    const outcome = await processNextOperation({ trustedInstanceId: TRUSTED, client, execute });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ result: 'rejected', status: 'preflight_failed' });
    expect(statuses(posts)).toEqual(['preflight_failed']);
  });

  it('writes back failure when the executor throws', async () => {
    const { client, posts } = recordingClient(op());
    const execute = vi.fn(async () => {
      throw new Error('docker daemon unreachable');
    });

    const outcome = await processNextOperation({ trustedInstanceId: TRUSTED, client, execute });

    expect(outcome).toMatchObject({ result: 'rejected', status: 'failed', reason: 'docker daemon unreachable' });
    expect(statuses(posts)).toEqual(['accepted', 'failed']);
  });
});

describe('drainOperations', () => {
  /** A client that hands out a finite queue of operations, then reports idle. */
  function queueClient(queue: PendingOperation[]): {
    client: BackendOperationsClient;
    posts: OperationStatusUpdate[];
  } {
    const posts: OperationStatusUpdate[] = [];
    let i = 0;
    const client: BackendOperationsClient = {
      fetchPending: async () => (i < queue.length ? queue[i++]! : null),
      postStatus: async (u) => {
        posts.push(u);
      },
    };
    return { client, posts };
  }

  it('returns an empty list when nothing is pending', async () => {
    const { client } = recordingClient(null);
    const execute = vi.fn();
    const outcomes = await drainOperations({ trustedInstanceId: TRUSTED, client, execute });
    expect(outcomes).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('drains a burst of pending operations in one invocation so none stay on "requested"', async () => {
    const { client } = queueClient([op({ operationId: 'op_1' }), op({ operationId: 'op_2' }), op({ operationId: 'op_3' })]);
    const execute = vi.fn(phasingExecutor(report({ ok: true })));

    const outcomes = await drainOperations({ trustedInstanceId: TRUSTED, client, execute });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.result === 'completed')).toBe(true);
    expect(outcomes.map((o) => (o.result === 'completed' ? o.operationId : null))).toEqual(['op_1', 'op_2', 'op_3']);
  });

  it('keeps draining past a rejected operation (a bad request never blocks the queue)', async () => {
    const { client } = queueClient([op({ operationId: 'op_evil', instanceId: 'inst-evil' }), op({ operationId: 'op_ok' })]);
    const execute = vi.fn(phasingExecutor(report({ ok: true })));

    const outcomes = await drainOperations({ trustedInstanceId: TRUSTED, client, execute });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ result: 'rejected', operationId: 'op_evil' });
    expect(outcomes[1]).toMatchObject({ result: 'completed', operationId: 'op_ok' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops at the per-drain safety cap if a misbehaving backend re-offers work forever', async () => {
    const { client } = recordingClient(op());
    const execute = vi.fn(phasingExecutor(report({ ok: true })));

    const outcomes = await drainOperations({ trustedInstanceId: TRUSTED, client, execute }, 3);

    expect(outcomes).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

describe('terminalStatus', () => {
  it('maps execution reports to the correct terminal lifecycle status', () => {
    expect(terminalStatus(report({ ok: true }))).toBe('succeeded');
    expect(terminalStatus(report({ ok: false, rolledBack: true }))).toBe('rolled_back');
    expect(
      terminalStatus(report({ ok: false, rolledBack: false, steps: [{ name: 'rollback', status: 'failed' }] })),
    ).toBe('rollback_failed');
    expect(terminalStatus(report({ ok: false, rolledBack: false, steps: [{ name: 'backup', status: 'failed' }] }))).toBe('failed');
  });
});
