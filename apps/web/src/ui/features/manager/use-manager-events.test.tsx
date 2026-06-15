// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act } from '../../test/render';
import { useManagerEvents } from './use-manager-events';
import type { EventSourceLike } from '../../lib/manager-events';

class FakeEventSource implements EventSourceLike {
  onerror: ((event: unknown) => void) | null = null;
  private readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  constructor(public readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  close(): void {}
  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function operationFrame(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    id: 'op-1',
    kind: 'instance_update',
    instanceId: 'demo',
    status: 'running',
    phase: 'pulling',
    startedAt: 't',
    finishedAt: null,
    ...over,
  });
}

function setup() {
  let source: FakeEventSource | null = null;
  const factory = (url: string): EventSourceLike => {
    source = new FakeEventSource(url);
    return source;
  };
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(() => useManagerEvents({ factory }), { wrapper });
  return {
    invalidate,
    emit: (data: string) => source!.emit('operation', data),
  };
}

describe('useManagerEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('invalidates the touched operation, its instance and the instances list', () => {
    const { invalidate, emit } = setup();

    act(() => {
      emit(operationFrame({ id: 'op-9', instanceId: 'demo' }));
    });
    // Burst-coalesced: nothing fires until the short window elapses.
    expect(invalidate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });

    const keys = invalidate.mock.calls.map((call) =>
      JSON.stringify((call[0] as { queryKey: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['manager', 'operation', 'op-9']));
    expect(keys).toContain(JSON.stringify(['manager', 'instance', 'demo']));
    expect(keys).toContain(JSON.stringify(['manager', 'instances']));
  });

  it('coalesces a burst of log-line events into a single invalidation pass', () => {
    const { invalidate, emit } = setup();

    act(() => {
      for (let i = 0; i < 5; i++) emit(operationFrame({ phase: `line-${i}` }));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // One op + one instance + the instances list = 3 invalidations for the burst.
    expect(invalidate).toHaveBeenCalledTimes(3);
  });
});
