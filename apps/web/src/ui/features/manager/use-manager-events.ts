// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Wires the manager BFF's Server-Sent-Events stream into React Query. Mounted
 * once by the authenticated console: each `operation` event invalidates exactly
 * the queries that the affected operation touches, so the operation history,
 * live log, instance detail and the left-hand instance list all refresh the
 * instant the backend changes — no polling lag.
 *
 * Policy: SSE-driven, NO time-based background polling. The feature queries
 * gate their `refetchInterval` on {@link useManagerSseConnected}, so a short
 * fallback poll runs ONLY while this stream is disconnected; the moment it
 * (re)connects the poll stops and one reconcile pass invalidates everything to
 * catch up on events missed while down (e.g. the BFF restarted mid-operation).
 *
 * Burst coalescing: a chatty operation emits a log line per Docker output row,
 * so events are batched into at most one invalidation pass per short window
 * rather than a refetch per line.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeManagerEvents, type EventSourceFactory, type ManagerOperationEvent } from '../../lib/manager-events';
import { INSTANCES_KEY } from './InstancesList';
import { setManagerSseConnected } from './manager-sse-status';

/** Prefix that covers every manager query (instance, operation, backups, …). */
const MANAGER_KEY = ['manager'] as const;

/** How long to batch a burst of events before invalidating (ms). */
const COALESCE_MS = 300;

export interface UseManagerEventsOptions {
  /** Test seam: inject a fake EventSource factory. */
  factory?: EventSourceFactory;
  /** Disable the stream (defaults to enabled). */
  enabled?: boolean;
}

export function useManagerEvents(options: UseManagerEventsOptions = {}): void {
  const queryClient = useQueryClient();
  const { factory, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    let operationIds = new Set<string>();
    let instanceIds = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Distinguish the first connect (queries already fetched on mount) from a
    // RE-connect after a drop, where `operation` events were likely missed and
    // the UI must reconcile.
    let hasConnectedBefore = false;

    const flush = (): void => {
      timer = null;
      const ops = operationIds;
      const instances = instanceIds;
      operationIds = new Set<string>();
      instanceIds = new Set<string>();

      for (const operationId of ops) {
        void queryClient.invalidateQueries({ queryKey: ['manager', 'operation', operationId] });
      }
      for (const instanceId of instances) {
        // Prefix-invalidate the instance and all of its sub-queries (detail,
        // operations, backups, schedule, mailer, env), mirroring the manual
        // "refresh" the detail page already performs.
        void queryClient.invalidateQueries({ queryKey: ['manager', 'instance', instanceId] });
      }
      // The left-hand list + dashboard inventory always reflect status / busy /
      // version, so refresh them on any change.
      void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
    };

    const onOperation = (event: ManagerOperationEvent): void => {
      operationIds.add(event.id);
      if (event.instanceId) instanceIds.add(event.instanceId);
      if (timer === null) timer = setTimeout(flush, COALESCE_MS);
    };

    const onOpen = (): void => {
      // Stream is live → the feature queries stop their fallback poll.
      setManagerSseConnected(true);
      // On a RE-connect, reconcile state that changed while the stream was
      // down (the whole point of dropping the timer poll).
      if (hasConnectedBefore) {
        void queryClient.invalidateQueries({ queryKey: MANAGER_KEY });
        void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
      }
      hasConnectedBefore = true;
    };

    const onError = (): void => {
      // Stream dropped → allow the fallback poll to take over while an
      // operation is in flight.
      setManagerSseConnected(false);
    };

    const unsubscribe = subscribeManagerEvents({
      onOperation,
      onOpen,
      onError,
      ...(factory ? { factory } : {}),
    });

    return () => {
      if (timer !== null) clearTimeout(timer);
      setManagerSseConnected(false);
      unsubscribe();
    };
  }, [queryClient, factory, enabled]);
}
