// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi } from 'vitest';
import { ApiError, createApiClient } from './api-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('api client', () => {
  it('GETs state and POSTs preflight to the right paths', async () => {
    const fetchImpl = vi.fn(async (input: string, _init?: RequestInit) =>
      jsonResponse({ mode: 'persistent', path: input }),
    );
    const client = createApiClient({ fetchImpl });

    await client.getState();
    expect(fetchImpl).toHaveBeenCalledWith('/api/state', expect.objectContaining({ method: 'GET' }));

    await client.runPreflight({ mode: 'production' });
    const [path, init] = fetchImpl.mock.calls[1]!;
    expect(path).toBe('/api/server/preflight');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ mode: 'production' }));
  });

  it('throws a typed ApiError carrying the server message (no stack trace)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'The instance is locked.' }, 409));
    const client = createApiClient({ fetchImpl });
    await expect(client.createBackup('clinic-a')).rejects.toMatchObject({ status: 409, message: 'The instance is locked.' });
    await expect(client.createBackup('clinic-a')).rejects.toBeInstanceOf(ApiError);
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
    await client.runPreflight({});
    const [, init] = fetchImpl.mock.calls[1]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-shm-csrf']).toBe('tok-123');
  });

  it('captures the CSRF token from the first-run setup response too', async () => {
    const fetchImpl = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input === '/api/setup/operator') {
        return jsonResponse({ ok: true, email: 'a@b.c', roles: ['server_owner'], csrfToken: 'tok-setup' });
      }
      return jsonResponse({ ok: true });
    });
    const client = createApiClient({ fetchImpl });
    await client.setupOperator('a@b.c', 'a sufficiently long pw');
    await client.setMailer('clinic-a', { dsn: 'smtp://user:pass@mail.example.org:587' });
    const [path, init] = fetchImpl.mock.calls[1]!;
    expect(path).toBe('/api/instances/clinic-a/mailer');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-shm-csrf']).toBe('tok-setup');
  });
});
