// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared connection state for the manager BFF Server-Sent-Events stream owned
 * by {@link useManagerEvents}.
 *
 * Policy (operator-chosen): SSE-driven, with NO time-based background polling.
 * The `/api/events` stream pushes an `operation` event whenever a journaled
 * operation advances (per log line, phase, success, failure), so the console
 * refreshes the affected queries instantly. A short fallback poll runs ONLY
 * while the stream is disconnected (and, for per-operation queries, while an
 * operation is still running), and stops the moment SSE reconnects.
 *
 * `useManagerEvents` (mounted once by the authenticated console) reports the
 * live state here; the feature queries read {@link managerFallbackInterval} /
 * {@link useManagerSseConnected} to decide whether their fallback poll runs.
 * Kept as a tiny external store (not React context) so producer and consumers
 * stay decoupled.
 */
import { useSyncExternalStore } from 'react';

let connected = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Report the live stream connection state (called by `useManagerEvents`). */
export function setManagerSseConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  emit();
}

/** Current stream connection state (non-reactive read). */
export function getManagerSseConnected(): boolean {
  return connected;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reactive stream connection state. `false` until the stream opens, so a fresh
 * mount with an in-flight operation still gets fallback polling until SSE is
 * confirmed up. On the server we report `true` (EventSource is browser-only) so
 * SSR never schedules a client-only fallback poll.
 */
export function useManagerSseConnected(): boolean {
  return useSyncExternalStore(subscribe, getManagerSseConnected, () => true);
}

/**
 * Fallback `refetchInterval` for a list/detail query: poll at `whenDisconnected`
 * ms ONLY while the SSE stream is down; `false` (no poll) while it is live.
 */
export function managerFallbackInterval(sseConnected: boolean, whenDisconnected: number): number | false {
  return sseConnected ? false : whenDisconnected;
}

/** Test-only: reset the module state between unit tests. */
export function __resetManagerSseStatusForTests(): void {
  connected = false;
  listeners.clear();
}
