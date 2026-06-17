// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Operation event stream (SSE) framing + delivery.
 *
 * Split out of the original monolithic `server.test.ts`; the shared BFF
 * harness (fake actions/stores, ephemeral test server, login, SPA dir +
 * cleanup) lives in `server-test-support`. The test bodies are unchanged.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog, InstanceLocks, OperationJournal, OperationRunner } from './jobs.js';
import type { ManagerInstanceActions } from './instances.js';
import { fakeActions, login, start, testServer } from './server-test-support.js';

describe('operation event stream (SSE)', () => {
  /** A manager wired with a real operation journal we can mutate in-test. */
  async function sseServer(tmpRoot: string): Promise<{ base: string; cookie: string; journal: OperationJournal }> {
    const journal = new OperationJournal(tmpRoot);
    const runner = new OperationRunner(journal, new AuditLog(tmpRoot), new InstanceLocks(tmpRoot));
    // The SSE endpoint only reads `journal`; the instance actions are never
    // invoked from /api/events, so a minimal stand-in keeps the test focused.
    const instances = {} as unknown as ManagerInstanceActions;
    const base = await start(
      testServer({ actions: fakeActions(), instanceManagement: { instances, runner, journal } }),
    );
    const { cookie } = await login(base);
    return { base, cookie, journal };
  }

  it('requires an authenticated session', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-sse-'));
    try {
      const { base } = await sseServer(tmpRoot);
      const res = await fetch(base + '/api/events');
      expect(res.status).toBe(401);
      await res.text(); // release the socket
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('pushes a live operation event the moment the journal changes', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shm-sse-'));
    const ac = new AbortController();
    try {
      const { base, cookie, journal } = await sseServer(tmpRoot);
      const res = await fetch(base + '/api/events', { headers: { cookie }, signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      // Safety net so a quiet stream can never hang the suite.
      const guard = setTimeout(() => ac.abort(), 8000);
      const readUntil = async (predicate: (t: string) => boolean): Promise<void> => {
        while (!predicate(text)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`SSE stream ended early; got:\n${text}`);
          if (value) text += decoder.decode(value, { stream: true });
        }
      };

      // Wait until the stream is live (so the server-side subscription exists),
      // THEN cause a change and read the pushed frame.
      await readUntil((t) => t.includes(': connected'));
      const op = await journal.create('instance_backup', 'sse-demo');
      await journal.complete(op.id, { ok: true });
      await readUntil((t) => t.includes(op.id) && t.includes('"status":"succeeded"'));

      expect(text).toContain('event: operation');
      expect(text).toContain('"instanceId":"sse-demo"');
      clearTimeout(guard);
      await reader.cancel().catch(() => undefined);
    } finally {
      ac.abort();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
