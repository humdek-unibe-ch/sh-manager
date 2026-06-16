// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '../../test/render';
import { useManagerEvents } from './use-manager-events';
import type { EventSourceLike } from '../../lib/manager-events';
import { __resetManagerSseStatusForTests, getManagerSseConnected } from './manager-sse-status';

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
  fail(): void {
    this.onerror?.({});
  }
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
    open: () => source!.emit('open'),
    fail: () => source!.fail(),
  };
}

describe('useManagerEvents connection state', () => {
  beforeEach(() => {
    __resetManagerSseStatusForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks the stream connected on open without reconciling on the FIRST connect', () => {
    const { invalidate, open } = setup();
    expect(getManagerSseConnected()).toBe(false);

    open();

    // First connect: queries already fetched on mount, so no reconcile pass.
    expect(getManagerSseConnected()).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('reconciles every manager query on a RE-connect (events missed while down)', () => {
    const { invalidate, open, fail } = setup();

    open(); // first connect
    fail(); // stream drops
    expect(getManagerSseConnected()).toBe(false);

    open(); // reconnect → reconcile

    expect(getManagerSseConnected()).toBe(true);
    const keys = invalidate.mock.calls.map((call) =>
      JSON.stringify((call[0] as { queryKey: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['manager']));
    expect(keys).toContain(JSON.stringify(['manager', 'instances']));
  });

  it('marks the stream disconnected on transport error', () => {
    const { open, fail } = setup();
    open();
    expect(getManagerSseConnected()).toBe(true);

    fail();
    expect(getManagerSseConnected()).toBe(false);
  });
});
