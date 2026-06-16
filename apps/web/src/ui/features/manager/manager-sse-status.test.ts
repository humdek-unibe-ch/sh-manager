// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetManagerSseStatusForTests,
  getManagerSseConnected,
  managerFallbackInterval,
  setManagerSseConnected,
} from './manager-sse-status';

describe('manager-sse-status', () => {
  beforeEach(() => {
    __resetManagerSseStatusForTests();
  });

  it('starts disconnected and reflects connect/disconnect transitions', () => {
    expect(getManagerSseConnected()).toBe(false);

    setManagerSseConnected(true);
    expect(getManagerSseConnected()).toBe(true);

    setManagerSseConnected(false);
    expect(getManagerSseConnected()).toBe(false);
  });

  it('keeps state stable across idempotent sets', () => {
    setManagerSseConnected(true);
    expect(getManagerSseConnected()).toBe(true);
    setManagerSseConnected(true);
    expect(getManagerSseConnected()).toBe(true);
  });

  it('gates the fallback poll: interval while disconnected, false while connected', () => {
    expect(managerFallbackInterval(false, 10_000)).toBe(10_000);
    expect(managerFallbackInterval(true, 10_000)).toBe(false);
  });
});
