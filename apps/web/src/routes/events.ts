// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Server-Sent Events stream of operation changes (authenticated, GET only).
 */
import type { ServerResponse } from 'node:http';
import type { ServerCtx } from './context.js';

/**
 * The web console subscribes here so operation/command progress — installs,
 * updates, backups, address/email/env changes, restarts — updates live instead
 * of waiting for the next poll. The browser keeps its polling as a fallback, so
 * a dropped stream never freezes the UI; this just removes the lag. The session
 * cookie authenticates the EventSource (same-origin GET, so no CSRF token is
 * needed).
 */
export function startEventStream(srv: ServerCtx, res: ServerResponse): void {
  const im = srv.options.instanceManagement;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  // Hold the connection open (the generic handler defaults to "close").
  res.setHeader('Connection', 'keep-alive');
  // Defeat buffering in any reverse proxy sitting in front of the manager.
  res.setHeader('X-Accel-Buffering', 'no');
  // Push every frame the instant it's written: disable Nagle so a tiny SSE
  // chunk isn't held back, and flush the headers so the client's EventSource
  // opens immediately rather than waiting for the first sizable write.
  res.socket?.setNoDelay(true);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');
  if (!im) return;

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (unsubscribe) unsubscribe();
  };

  unsubscribe = im.journal.subscribe((event) => {
    try {
      res.write(`event: operation\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      cleanup();
    }
  });
  // A periodic comment keeps idle intermediaries from dropping the stream and
  // lets the client detect a dead server promptly. unref() so the heartbeat
  // never keeps the process (or a test runner) alive on its own.
  heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 15_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  res.on('close', cleanup);
  res.on('error', cleanup);
}
