// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Browser client for the manager BFF's Server-Sent-Events stream
 * (`GET /api/events`, see `apps/web/src/server.ts`).
 *
 * The stream pushes a compact `operation` event whenever a journaled operation
 * is created or advances (log line, phase, success, failure). The web console
 * uses it to refresh the affected queries instantly instead of waiting for the
 * next poll — polling stays on as a fallback, so a dropped stream only costs a
 * little latency, never correctness.
 *
 * `EventSource` is injected (and feature-detected) so this is unit-testable
 * without the DOM and degrades to a no-op when the runtime has no EventSource
 * (old browsers, SSR, jsdom) — in which case the caller's polling carries on.
 */

/** The operation change payload (mirrors `OperationEvent` in `jobs.ts`). */
export interface ManagerOperationEvent {
  id: string;
  kind: string;
  instanceId: string | null;
  status: 'running' | 'succeeded' | 'failed';
  phase: string;
  startedAt: string;
  finishedAt: string | null;
}

/** Minimal slice of the DOM `EventSource` we depend on (test seam). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface SubscribeManagerEventsOptions {
  /** Stream URL; defaults to the same-origin `/api/events`. */
  url?: string;
  /** EventSource factory; defaults to the global `EventSource` when present. */
  factory?: EventSourceFactory;
  onOperation: (event: ManagerOperationEvent) => void;
  /** Notified on transport errors (EventSource auto-reconnects regardless). */
  onError?: (error: unknown) => void;
}

function defaultFactory(): EventSourceFactory | null {
  if (typeof EventSource === 'undefined') return null;
  // Same-origin stream; withCredentials keeps the session cookie attached when
  // the manager is reached through a reverse proxy.
  return (url) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;
}

/**
 * Open the operation event stream. Returns an unsubscribe function that closes
 * the connection. When no EventSource is available the returned function is a
 * no-op and nothing is opened (the caller keeps polling).
 */
export function subscribeManagerEvents(options: SubscribeManagerEventsOptions): () => void {
  const url = options.url ?? '/api/events';
  const factory = options.factory ?? defaultFactory();
  if (!factory) return () => {};

  let source: EventSourceLike;
  try {
    source = factory(url);
  } catch (error) {
    options.onError?.(error);
    return () => {};
  }

  source.addEventListener('operation', (event) => {
    if (!event.data) return;
    try {
      options.onOperation(JSON.parse(event.data) as ManagerOperationEvent);
    } catch {
      // Ignore a malformed frame rather than tearing the stream down.
    }
  });
  source.onerror = (error) => options.onError?.(error);

  return () => {
    try {
      source.close();
    } catch {
      // Already closed / torn down.
    }
  };
}
