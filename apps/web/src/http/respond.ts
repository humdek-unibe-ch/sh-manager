// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared HTTP response helpers for the manager BFF: a typed {@link HttpError}
 * that the request pipeline maps to a status code, and {@link sendJson} for the
 * single, never-cached JSON response shape every `/api` route returns.
 */
import type { ServerResponse } from 'node:http';

/** An error carrying the HTTP status the handler/pipeline should answer with. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Every /api response is dynamic (server state, manager version, health,
  // sessions) and must NEVER be cached. Without this a browser could keep a
  // stale /api/state — which carries `managerVersion` — and the GUI kept showing
  // the previous version after a manager update even across a hard refresh.
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}
