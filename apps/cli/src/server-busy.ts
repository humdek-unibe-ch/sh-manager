// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * "Is the manager busy?" detection, used to refuse a self-update while an
 * instance operation is still in flight.
 *
 * The web BFF journals every mutating operation (install/update/backup/restore/
 * plugin drain, …) as `<root>/manager/operations/<id>.json` and marks it
 * `running` until it finishes. A `self-update` recreates the long-running
 * `sh-manager-web` container; doing that mid-operation kills the operation
 * half-way — exactly how a half-removed plugin or a half-applied update is
 * produced. Reading the journal lets the CLI block the update until the server
 * is idle (with an explicit `--force` escape for stale entries).
 *
 * This reader is intentionally standalone (no dependency on the web app) and
 * never throws: an unreadable journal degrades to "not busy" so an offline /
 * never-used-the-GUI server can still self-update.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Operations journal directory (mirrors apps/web `OperationJournal`). */
export function operationsDir(root: string): string {
  return path.join(root, 'manager', 'operations');
}

export interface RunningOperation {
  id: string;
  kind: string;
  /** Instance the operation mutates; null for server-level work. */
  instanceId: string | null;
  phase: string;
  startedAt: string;
}

/**
 * Scans the operation journal for entries still marked `running`. Best-effort:
 * a missing directory or any unreadable / non-JSON file is skipped, never
 * thrown — the caller treats an empty result as "idle".
 */
export async function findRunningOperations(root: string): Promise<RunningOperation[]> {
  let entries: string[];
  try {
    entries = await readdir(operationsDir(root));
  } catch {
    return [];
  }
  const running: RunningOperation[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(path.join(operationsDir(root), name), 'utf8');
      const rec = JSON.parse(raw) as {
        id?: unknown;
        kind?: unknown;
        instanceId?: unknown;
        phase?: unknown;
        startedAt?: unknown;
        status?: unknown;
      };
      if (rec.status !== 'running' || typeof rec.id !== 'string') continue;
      running.push({
        id: rec.id,
        kind: typeof rec.kind === 'string' ? rec.kind : 'operation',
        instanceId: typeof rec.instanceId === 'string' ? rec.instanceId : null,
        phase: typeof rec.phase === 'string' ? rec.phase : '',
        startedAt: typeof rec.startedAt === 'string' ? rec.startedAt : '',
      });
    } catch {
      // Skip truncated / non-JSON files; a partial write must not block updates.
    }
  }
  return running.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** One-line human description of a running operation (age included when known). */
export function describeRunningOperation(op: RunningOperation, now: Date = new Date()): string {
  const scope = op.instanceId ? `instance ${op.instanceId}` : 'server';
  const started = Date.parse(op.startedAt);
  let age = '';
  if (Number.isFinite(started)) {
    const mins = Math.max(0, Math.round((now.getTime() - started) / 60000));
    age = ` — running ${mins}m`;
  }
  return `${op.id}: ${op.kind} (${scope})${op.phase ? ` [${op.phase}]` : ''}${age}`;
}
