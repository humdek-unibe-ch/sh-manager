// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi } from 'vitest';
import { subscribeManagerEvents, type EventSourceLike, type ManagerOperationEvent } from './manager-events';

/** In-memory EventSource so the stream logic is testable without the DOM. */
class FakeEventSource implements EventSourceLike {
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  constructor(public readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

describe('subscribeManagerEvents', () => {
  it('parses operation frames and forwards them to onOperation; close() unsubscribes', () => {
    let source: FakeEventSource | null = null;
    const received: ManagerOperationEvent[] = [];
    const stop = subscribeManagerEvents({
      url: '/api/events',
      factory: (url) => {
        source = new FakeEventSource(url);
        return source;
      },
      onOperation: (event) => received.push(event),
    });
    expect(source!.url).toBe('/api/events');

    const payload: ManagerOperationEvent = {
      id: 'op-1',
      kind: 'instance_backup',
      instanceId: 'demo',
      status: 'succeeded',
      phase: 'done',
      startedAt: 't0',
      finishedAt: 't1',
    };
    source!.emit('operation', JSON.stringify(payload));
    expect(received).toEqual([payload]);

    stop();
    expect(source!.closed).toBe(true);
  });

  it('ignores a malformed or empty frame instead of throwing', () => {
    let source: FakeEventSource | null = null;
    const received: ManagerOperationEvent[] = [];
    subscribeManagerEvents({
      factory: (url) => {
        source = new FakeEventSource(url);
        return source;
      },
      onOperation: (event) => received.push(event),
    });
    expect(() => source!.emit('operation', '{ not json')).not.toThrow();
    expect(() => source!.emit('operation', undefined)).not.toThrow();
    expect(received).toEqual([]);
  });

  it('degrades to a safe no-op when the stream cannot be opened (polling keeps working)', () => {
    const onOperation = vi.fn();
    const onError = vi.fn();
    const stop = subscribeManagerEvents({
      factory: () => {
        throw new Error('EventSource unavailable');
      },
      onOperation,
      onError,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onOperation).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
