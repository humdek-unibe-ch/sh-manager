// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { evaluateHealth, isHealthy } from './health.js';

const now = () => '2026-06-05T10:00:00.000Z';

describe('evaluateHealth', () => {
  it('is healthy when all probes pass', () => {
    const r = evaluateHealth('website1', [
      { service: 'backend', ok: true },
      { service: 'frontend', ok: true },
      { service: 'mysql', ok: true },
      { service: 'redis', ok: true },
      { service: 'scheduler', ok: true },
    ], now);
    expect(r.overall).toBe('healthy');
    expect(isHealthy(r)).toBe(true);
  });

  it('is unhealthy when a required service fails', () => {
    const r = evaluateHealth('website1', [
      { service: 'backend', ok: false, detail: '500' },
      { service: 'frontend', ok: true },
    ], now);
    expect(r.overall).toBe('unhealthy');
  });

  it('is degraded when only an optional service fails', () => {
    const r = evaluateHealth('website1', [
      { service: 'backend', ok: true },
      { service: 'frontend', ok: true },
      { service: 'mysql', ok: true },
      { service: 'redis', ok: true },
      { service: 'scheduler', ok: false },
    ], now);
    expect(r.overall).toBe('degraded');
  });

  it('is unknown without probes', () => {
    expect(evaluateHealth('website1', [], now).overall).toBe('unknown');
  });

  it('honours an explicit required override', () => {
    const r = evaluateHealth('website1', [{ service: 'mercure', ok: false, required: true }], now);
    expect(r.overall).toBe('unhealthy');
  });
});
