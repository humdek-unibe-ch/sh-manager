// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Manager HTTP server (Node built-ins only) — the single, always-authenticated
 * operations console. There is no separate "bootstrap mode" anymore: a fresh
 * server starts with the same console, offers a one-time "create the first
 * operator" setup (localhost-guarded), and the create-instance wizard performs
 * the server bootstrap (proxy + inventory) as part of the first install.
 *
 * Security posture (must-not-break rules 12-13 + HIGH 1 acceptance):
 *   - Binds to 127.0.0.1 by default. A non-loopback bind is refused unless the
 *     operator explicitly opts in (`allowNonLocal`).
 *   - A Host-header allowlist defends the localhost UI against DNS-rebinding
 *     (skipped only when the operator explicitly exposed the UI non-locally).
 *   - Every API route requires an authenticated operator session, with CSRF on
 *     state-changing requests. The only pre-auth routes are the sign-in
 *     metadata, login, and the first-run operator setup — and setup hard-locks
 *     itself as soon as one enabled local operator exists.
 *
 * All side effects go through the injected {@link BootstrapActions} and
 * {@link ManagerInstanceActions}. The leaf HTTP helpers live in `http/*` and the
 * route bodies in `routes/*`; this file keeps the server wiring, the auth/CSRF
 * gate, and the request pipeline so the security ordering stays in one place.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { destroySession, emptySessionTable, isBootstrapRequired, verifyCsrf, type OperatorStore } from '@shm/auth';
import type { BootstrapActions } from './actions.js';
import type { OperationJournal, OperationRunner } from './jobs.js';
import type { ManagerInstanceActions } from './instances.js';
import { HttpError, sendJson } from './http/respond.js';
import { serveAppShell, serveStatic } from './http/static.js';
import { SESSION_COOKIE } from './http/cookies.js';
import { hostHeaderIsLocal, isLoopbackHost } from './http/host-guard.js';
import type { RequestContext, ServerCtx } from './routes/context.js';
import { handleLogin, handleSetupOperator, loadSession } from './routes/auth.js';
import { startEventStream } from './routes/events.js';
import { routeInstanceManagement } from './routes/instances.js';

export { browseUrl, isLoopbackHost } from './http/host-guard.js';

/** Default official registry, used when a preflight/version request names none. */
export const DEFAULT_REGISTRY_URL = 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/';

export interface ManagerServerOptions {
  actions: BootstrapActions;
  host?: string;
  port?: number;
  allowNonLocal?: boolean;
  /** Operator accounts (required — every API route is authenticated). */
  operatorStore: OperatorStore;
  sessionLifetimeSeconds?: number;
  /** Directory of the built React SPA (Vite `dist-web`). Falls back to an inline notice. */
  clientDir?: string;
  /** Manager version surfaced in every state snapshot (UI header/footer). */
  managerVersion?: string;
  /** Registry consulted by preflight/version lookups when the client names none. */
  defaultRegistryUrl?: string;
  /**
   * Instance lifecycle management. All mutating actions run through the
   * operation journal + audit log + per-instance lock and return
   * `202 { operationId }`.
   */
  instanceManagement?: {
    instances: ManagerInstanceActions;
    runner: OperationRunner;
    journal: OperationJournal;
  };
  now?: () => Date;
}

export interface ManagerServerHandle {
  /** Raw request handler (used directly in tests). */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Underlying http.Server. */
  server: Server;
  /** Start listening; resolves with the bound address. */
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createManagerServer(options: ManagerServerOptions): ManagerServerHandle {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8765;
  const allowNonLocal = options.allowNonLocal ?? false;
  const clientDir = options.clientDir ? resolve(options.clientDir) : undefined;
  const defaultRegistryUrl = options.defaultRegistryUrl ?? DEFAULT_REGISTRY_URL;
  const now = options.now ?? (() => new Date());

  if (!isLoopbackHost(host) && !allowNonLocal) {
    throw new Error(
      `Refusing to bind the manager UI to non-loopback host "${host}". Set allowNonLocal explicitly to expose it (auth required).`,
    );
  }

  // Server-scoped context shared with the extracted route handlers. `sessions`
  // is the one mutable field — login/setup/logout reassign it.
  const srv: ServerCtx = {
    options,
    now,
    defaultRegistryUrl,
    clientDir,
    allowNonLocal,
    port,
    sessions: emptySessionTable(),
  };

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Invalid JSON body.');
    }
  }

  /** Routes that work without a session (the sign-in / first-run screens). */
  const PRE_AUTH_ROUTES = new Set(['/api/auth/meta', '/api/login', '/api/setup/operator']);

  async function route(ctx: RequestContext, res: ServerResponse): Promise<void> {
    const path = ctx.url.pathname;
    const isApi = path.startsWith('/api/');

    // Authentication gate. Only the JSON API is gated; the static SPA shell +
    // assets are always served (they contain no secrets) so the sign-in screen
    // can load before authentication.
    if (isApi && !PRE_AUTH_ROUTES.has(path) && !ctx.session) {
      throw new HttpError(401, 'Authentication required.');
    }
    // CSRF for state-changing requests on authenticated routes. Login/setup
    // create the session (no token exists yet) — they are guarded by the
    // loopback bind + Host allowlist + credential checks instead.
    if (ctx.session && ctx.method !== 'GET' && !PRE_AUTH_ROUTES.has(path)) {
      if (!ctx.csrf || !verifyCsrf(srv.sessions, ctx.session.id, ctx.csrf, now())) {
        throw new HttpError(403, 'Invalid or missing CSRF token.');
      }
    }

    if (path === '/api/auth/meta' && ctx.method === 'GET') {
      // Pre-auth sign-in metadata: whether any enabled local operator exists.
      // Boolean only — no emails, roles, or counts — so the sign-in screen can
      // offer "create the first operator" instead of a login form that can
      // never succeed.
      const operatorsConfigured = !isBootstrapRequired(await options.operatorStore.load());
      return sendJson(res, 200, {
        mode: 'persistent',
        operatorsConfigured,
        ...(options.managerVersion ? { managerVersion: options.managerVersion } : {}),
      });
    }
    if (path === '/api/login' && ctx.method === 'POST') return handleLogin(srv, ctx, res);
    if (path === '/api/setup/operator' && ctx.method === 'POST') return handleSetupOperator(srv, ctx, res);
    if (path === '/api/logout' && ctx.method === 'POST') {
      if (ctx.session) srv.sessions = destroySession(srv.sessions, ctx.session.id);
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }

    // Operations endpoints (journal reads + the live SSE stream).
    if (options.instanceManagement) {
      if (path === '/api/events' && ctx.method === 'GET') {
        startEventStream(srv, res);
        return;
      }
      if (path === '/api/operations' && ctx.method === 'GET') {
        const instanceId = ctx.url.searchParams.get('instanceId') ?? undefined;
        sendJson(res, 200, {
          operations: await options.instanceManagement.journal.list(instanceId !== undefined ? { instanceId } : {}),
        });
        return;
      }
      const opMatch = path.match(/^\/api\/operations\/([a-z0-9-]+)$/i);
      if (opMatch && ctx.method === 'GET') {
        const record = await options.instanceManagement.journal.get(opMatch[1]!);
        if (!record) throw new HttpError(404, 'Operation not found.');
        sendJson(res, 200, record);
        return;
      }
    }

    // Static SPA: shell at "/", hashed assets under any other non-API GET path.
    if (ctx.method === 'GET' && !isApi) {
      if (path === '/') return serveAppShell(clientDir, res);
      if (clientDir && (await serveStatic(clientDir, path, res))) return;
      // Unknown non-API path: serve the shell so the SPA can render (no client router today, but safe).
      return serveAppShell(clientDir, res);
    }

    if (await routeInstanceManagement(srv, ctx, res)) return;

    if (path === '/api/state' && ctx.method === 'GET') {
      // Authenticated sessions get their identity + CSRF token back so a page
      // RELOAD can keep working: the session cookie survives the reload but
      // the in-memory client token does not. Safe to return on a GET: the
      // response is same-origin JSON behind the SameSite=Strict session
      // cookie, so a cross-site page can never read it.
      const session = ctx.session
        ? { email: ctx.session.email, roles: ctx.session.roles, csrfToken: ctx.session.csrfToken }
        : undefined;
      return sendJson(res, 200, {
        mode: 'persistent',
        ...(options.managerVersion ? { managerVersion: options.managerVersion } : {}),
        ...(session ? { session } : {}),
      });
    }
    if (path === '/api/manager/update-check' && ctx.method === 'GET') {
      if (!options.actions.checkManagerUpdate) throw new HttpError(404, 'Not found.');
      return sendJson(res, 200, await options.actions.checkManagerUpdate());
    }
    if (path === '/api/registry/versions' && ctx.method === 'GET') {
      if (!options.actions.listVersions) throw new HttpError(404, 'Not found.');
      const raw = ctx.url.searchParams.get('registryUrl');
      const registryUrl = raw && /^https?:\/\//.test(raw) ? raw : defaultRegistryUrl;
      const channel = ctx.url.searchParams.get('channel') ?? 'stable';
      // `kind` selects the registry feed: the core release line (default) or the
      // independently-released frontend line (frontend-only update dialog).
      const kind = ctx.url.searchParams.get('kind') === 'frontend' ? 'frontend' : 'core';
      return sendJson(res, 200, await options.actions.listVersions(registryUrl, channel, kind));
    }

    throw new HttpError(404, 'Not found.');
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // Low-traffic localhost admin UI: close each connection so no socket is
      // kept alive (also keeps clients from pooling stale sockets across runs).
      res.setHeader('Connection', 'close');
      try {
        // DNS-rebinding guard for the localhost UI. Skipped only when the
        // operator explicitly exposed the UI beyond loopback (reverse proxy /
        // LAN), where foreign Host headers are expected and auth still gates
        // every route.
        if (!allowNonLocal && !hostHeaderIsLocal(req)) {
          throw new HttpError(421, 'The manager UI only serves localhost (DNS-rebinding guard).');
        }
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);
        const method = req.method ?? 'GET';
        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
        const body = needsBody ? await readBody(req) : undefined;
        const session = await loadSession(srv, req);
        const csrf = (req.headers['x-shm-csrf'] as string | undefined) ?? null;
        const sourceIp = req.socket?.remoteAddress ?? null;
        await route({ url, method, body, session, csrf, sourceIp }, res);
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { error: err.message });
        } else {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error.' });
        }
      }
    })();
  };

  const server = createServer(handler);

  return {
    handler,
    server,
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') resolve({ host: addr.address, port: addr.port });
          else resolve({ host, port });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // A long-lived SSE stream (`/api/events`) would otherwise keep close()
        // pending until the browser disconnects. Force active connections shut
        // so shutdown — and test teardown — is prompt.
        server.closeAllConnections?.();
      });
    },
  };
}
