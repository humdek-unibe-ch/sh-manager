// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Local-bind host guard, browse-URL builder and the manager server binding (loopback default + optional non-local bind).
 *
 * Split out of the original monolithic `server.test.ts`; the shared BFF
 * harness (fake actions/stores, ephemeral test server, login, SPA dir +
 * cleanup) lives in `server-test-support`. The test bodies are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { browseUrl, isLoopbackHost } from './server.js';
import { fakeActions, start, testServer } from './server-test-support.js';

describe('isLoopbackHost', () => {
  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('browseUrl', () => {
  it('maps a wildcard bind (in-container) to a localhost URL the operator can open', () => {
    expect(browseUrl('0.0.0.0', 8765)).toBe('http://localhost:8765');
    expect(browseUrl('::', 8765)).toBe('http://localhost:8765');
  });

  it('keeps explicit binds as-is (bracketing IPv6)', () => {
    expect(browseUrl('127.0.0.1', 8765)).toBe('http://127.0.0.1:8765');
    expect(browseUrl('::1', 9000)).toBe('http://[::1]:9000');
  });
});

describe('manager server binding', () => {
  it('binds to 127.0.0.1 by default', async () => {
    const base = await start(testServer({ actions: fakeActions() }));
    expect(base).toContain('127.0.0.1');
  });

  it('refuses a non-loopback bind unless explicitly allowed', () => {
    expect(() => testServer({ actions: fakeActions(), host: '0.0.0.0' })).not.toThrow();
    expect(() => testServer({ actions: fakeActions(), host: '203.0.113.5' })).toThrow(/non-loopback/);
    expect(() => testServer({ actions: fakeActions(), host: '203.0.113.5', allowNonLocal: true })).not.toThrow();
  });

  it('rejects foreign Host headers (DNS-rebinding guard)', async () => {
    // fetch()/undici refuses to override Host, so drive the raw http client.
    const { request } = await import('node:http');
    const base = await start(testServer({ actions: fakeActions() }));
    const { port } = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/auth/meta', headers: { host: 'evil.example.com' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });
});
