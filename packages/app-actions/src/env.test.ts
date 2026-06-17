// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { localhostProbeHost, rewriteLocalhostUrl } from './env.js';

describe('containerised health-probe URL rewrite', () => {
  it('rewrites loopback hostnames to the probe host and leaves everything else alone', () => {
    expect(rewriteLocalhostUrl('http://localhost:8090/cms-api/v1/health', 'host.docker.internal')).toBe(
      'http://host.docker.internal:8090/cms-api/v1/health',
    );
    expect(rewriteLocalhostUrl('http://127.0.0.1:8090/x', 'host.docker.internal')).toBe('http://host.docker.internal:8090/x');
    expect(rewriteLocalhostUrl('https://clinic-a.example/cms-api/v1/health', 'host.docker.internal')).toBe(
      'https://clinic-a.example/cms-api/v1/health',
    );
    expect(rewriteLocalhostUrl('not a url', 'host.docker.internal')).toBe('not a url');
  });

  it('is a no-op without a probe host (manager running directly on the host)', () => {
    expect(rewriteLocalhostUrl('http://localhost:8090/health', undefined)).toBe('http://localhost:8090/health');
  });

  describe('probe host detection', () => {
    afterEach(() => {
      delete process.env.SELFHELP_LOCALHOST_PROBE_HOST;
    });

    it('honours the explicit override and the "off" switch', () => {
      process.env.SELFHELP_LOCALHOST_PROBE_HOST = 'gateway.docker.internal';
      expect(localhostProbeHost()).toBe('gateway.docker.internal');
      process.env.SELFHELP_LOCALHOST_PROBE_HOST = 'off';
      expect(localhostProbeHost()).toBeUndefined();
    });
  });
});
