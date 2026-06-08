// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Typed client for the manager BFF JSON API (see `apps/web/src/server.ts`).
 *
 * - One method per endpoint, all returning typed results.
 * - CSRF tokens (persistent mode) are captured on login and replayed on every
 *   state-changing request automatically.
 * - Failures throw {@link ApiError} carrying the HTTP status and the server's
 *   human message — never a stack trace. Callers turn these into friendly UI.
 * - `fetch` is injectable so the client is unit-testable without a network.
 */
import type { LoginResult, Snapshot, WizardConfig, WizardStepId } from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export interface ApiClient {
  getState(): Promise<Snapshot>;
  setConfig(patch: Partial<WizardConfig>): Promise<Snapshot>;
  advance(): Promise<Snapshot>;
  back(): Promise<Snapshot>;
  runCheck(step: WizardStepId): Promise<Snapshot>;
  install(): Promise<Snapshot>;
  login(email: string, password: string): Promise<LoginResult>;
  logout(): Promise<void>;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '';
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let csrfToken: string | null = null;

  async function request<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken && method !== 'GET') headers['x-shm-csrf'] = csrfToken;

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, 'Could not reach the manager service. Check that it is still running.');
    }

    const data = parseJson(await res.text());
    if (!res.ok) {
      const message =
        (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
          ? (data as { error: string }).error
          : null) ?? `Request failed (${res.status}).`;
      throw new ApiError(res.status, message);
    }
    return data as T;
  }

  return {
    getState: () => request<Snapshot>('/api/state', 'GET'),
    setConfig: (patch) => request<Snapshot>('/api/config', 'POST', patch),
    advance: () => request<Snapshot>('/api/advance', 'POST'),
    back: () => request<Snapshot>('/api/back', 'POST'),
    runCheck: (step) => request<Snapshot>(`/api/check/${step}`, 'POST'),
    install: () => request<Snapshot>('/api/install', 'POST'),
    async login(email, password) {
      const result = await request<LoginResult>('/api/login', 'POST', { email, password });
      csrfToken = result.csrfToken;
      return result;
    },
    async logout() {
      await request<{ ok: boolean }>('/api/logout', 'POST');
      csrfToken = null;
    },
  };
}
