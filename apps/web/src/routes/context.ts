// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Per-request and per-server context objects passed to the extracted route
 * handlers. Splitting the BFF into route modules means the handlers can no
 * longer close over `createManagerServer`'s locals, so the server builds one
 * {@link ServerCtx} (created once) and threads the per-request
 * {@link RequestContext} through each call. Behaviour is unchanged — these are
 * the same values the handlers used to read from the enclosing closure.
 */
import type { ManagerSession, SessionTable } from '@shm/auth';
// Type-only import: erased at runtime, so this does not create an import cycle
// with server.ts (which imports the route handlers as values).
import type { ManagerServerOptions } from '../server.js';

export interface RequestContext {
  url: URL;
  method: string;
  body: unknown;
  session: ManagerSession | null;
  csrf: string | null;
  /** Remote socket address, recorded in the audit log. */
  sourceIp: string | null;
}

/**
 * Server-scoped context shared by every route handler. Mostly the resolved
 * server options; `sessions` is the one MUTABLE field — login/setup/logout
 * reassign it (the auth session table is value-immutable, so a new table is
 * stored back after each change).
 */
export interface ServerCtx {
  readonly options: ManagerServerOptions;
  readonly now: () => Date;
  readonly defaultRegistryUrl: string;
  readonly clientDir: string | undefined;
  readonly allowNonLocal: boolean;
  readonly port: number;
  sessions: SessionTable;
}
