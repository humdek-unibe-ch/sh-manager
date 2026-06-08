// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi } from 'vitest';
import { ApiError, createApiClient } from './api-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('api client', () => {
  it('GETs state and POSTs config to the right paths', async () => {
    const fetchImpl = vi.fn(async (input: string, _init?: RequestInit) =>
      jsonResponse({ step: 'welcome', mode: 'bootstrap', path: input }),
    );
    const client = createApiClient({ fetchImpl });

    await client.getState();
    expect(fetchImpl).toHaveBeenCalledWith('/api/state', expect.objectContaining({ method: 'GET' }));

    await client.setConfig({ instanceName: 'Clinic A' });
    const [, init] = fetchImpl.mock.calls[1]!;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ instanceName: 'Clinic A' }));
  });

  it('throws a typed ApiError carrying the server message (no stack trace)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'The docker check failed.' }, 409));
    const client = createApiClient({ fetchImpl });
    await expect(client.advance()).rejects.toMatchObject({ status: 409, message: 'The docker check failed.' });
    await expect(client.advance()).rejects.toBeInstanceOf(ApiError);
  });

  it('reports a friendly message when the service is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = createApiClient({ fetchImpl });
    await expect(client.getState()).rejects.toMatchObject({ status: 0 });
  });

  it('replays the CSRF token on mutations after login', async () => {
    const fetchImpl = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input === '/api/login') return jsonResponse({ ok: true, email: 'a@b.c', roles: [], csrfToken: 'tok-123' });
      return jsonResponse({ ok: true });
    });
    const client = createApiClient({ fetchImpl });
    await client.login('a@b.c', 'pw');
    await client.runCheck('docker');
    const [, init] = fetchImpl.mock.calls[1]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-shm-csrf']).toBe('tok-123');
  });
});
