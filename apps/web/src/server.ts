// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Bootstrap / persistent manager HTTP server (Node built-ins only).
 *
 * Security posture (must-not-break rules 12-13 + HIGH 1 acceptance):
 *   - Binds to 127.0.0.1 by default. A non-loopback bind is refused unless the
 *     operator explicitly opts in (`allowNonLocal`).
 *   - A Host-header allowlist defends the unauthenticated localhost bootstrap
 *     flow against DNS-rebinding.
 *   - The bootstrap wizard is unauthenticated BUT localhost-only and self-locks
 *     after a successful install (returns 410) unless persistent mode is on.
 *   - Persistent mode requires an authenticated operator session for every API
 *     route, with CSRF on state-changing requests.
 *
 * The server holds one in-memory wizard state and one session table; all
 * side effects go through the injected {@link BootstrapActions}.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { OperatorStore } from '@shm/auth';
import {
  authenticateLocal,
  createSession,
  destroySession,
  emptySessionTable,
  getSession,
  verifyCsrf,
  type ManagerSession,
  type SessionTable,
} from '@shm/auth';
import {
  dockerToCheck,
  healthToCheck,
  installToCheck,
  registryToCheck,
  resourceToCheck,
  type BootstrapActions,
} from './actions.js';
import {
  advance,
  back,
  buildBootstrapPlan,
  canAdvance,
  currentStep,
  initWizard,
  isBootstrapComplete,
  recordCheck,
  setConfig,
  WizardError,
  type WizardConfig,
  type WizardState,
} from './wizard.js';
import { renderWizardHtml } from './ui.js';

export type ServerMode = 'bootstrap' | 'persistent';

export interface BootstrapServerOptions {
  actions: BootstrapActions;
  mode?: ServerMode;
  host?: string;
  port?: number;
  allowNonLocal?: boolean;
  requiredPorts?: number[];
  operatorStore?: OperatorStore;
  sessionLifetimeSeconds?: number;
  /** Keep serving after a successful bootstrap (otherwise routes self-lock). */
  persistAfterBootstrap?: boolean;
  initialConfig?: Partial<WizardConfig>;
  now?: () => Date;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function hostHeaderIsLocal(req: IncomingMessage): boolean {
  const raw = req.headers.host;
  if (!raw) return true; // no Host header (HTTP/1.0 / direct socket) — allow on loopback bind
  const hostname = raw.split(':')[0] ?? '';
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost' || hostname === '[::1]';
}

interface RequestContext {
  url: URL;
  method: string;
  body: unknown;
  session: ManagerSession | null;
  csrf: string | null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

const SESSION_COOKIE = 'shm_session';

export interface BootstrapServerHandle {
  /** Raw request handler (used directly in tests). */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Underlying http.Server. */
  server: Server;
  /** Start listening; resolves with the bound address. */
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  /** Current wizard state (read-only snapshot for tests). */
  getState(): WizardState;
}

export function createBootstrapServer(options: BootstrapServerOptions): BootstrapServerHandle {
  const mode: ServerMode = options.mode ?? 'bootstrap';
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8765;
  const allowNonLocal = options.allowNonLocal ?? false;
  const now = options.now ?? (() => new Date());

  if (!isLoopbackHost(host) && !allowNonLocal) {
    throw new Error(
      `Refusing to bind the manager UI to non-loopback host "${host}". Set allowNonLocal explicitly to expose it (auth required).`,
    );
  }
  if (mode === 'persistent' && !options.operatorStore) {
    throw new Error('Persistent mode requires an operator store for authentication.');
  }

  let state = initWizard(options.initialConfig);
  let sessions: SessionTable = emptySessionTable();

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

  async function loadSession(req: IncomingMessage): Promise<ManagerSession | null> {
    const cookies = parseCookies(req.headers.cookie);
    const id = cookies[SESSION_COOKIE];
    if (!id) return null;
    return getSession(sessions, id, now());
  }

  async function handleLogin(ctx: RequestContext, res: ServerResponse): Promise<void> {
    const store = options.operatorStore;
    if (!store) throw new HttpError(500, 'No operator store configured.');
    const body = (ctx.body ?? {}) as { email?: string; password?: string };
    if (!body.email || !body.password) throw new HttpError(400, 'Email and password are required.');
    const table = await store.load();
    const result = authenticateLocal(table, body.email, body.password);
    if (!result.ok || !result.operator) throw new HttpError(401, result.reason ?? 'Invalid credentials.');
    const created = createSession(
      sessions,
      {
        operatorId: result.operator.id,
        email: result.operator.email,
        roles: result.operator.roles,
        ...(options.sessionLifetimeSeconds ? { lifetimeSeconds: options.sessionLifetimeSeconds } : {}),
      },
      now(),
    );
    sessions = created.table;
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${created.session.id}; HttpOnly; SameSite=Strict; Path=/`);
    sendJson(res, 200, { ok: true, email: created.session.email, roles: created.session.roles, csrfToken: created.session.csrfToken });
  }

  function snapshot(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      mode,
      step: currentStep(state),
      stepIndex: state.stepIndex,
      steps: state.steps,
      config: state.config,
      checks: state.checks,
      completed: state.completed,
      canAdvance: canAdvance(state),
      ...extra,
    };
  }

  async function runCheck(step: string, res: ServerResponse): Promise<void> {
    switch (step) {
      case 'docker':
        state = recordCheck(state, 'docker', dockerToCheck(await options.actions.checkDocker()));
        break;
      case 'internet':
        state = recordCheck(state, 'internet', await options.actions.checkInternet());
        break;
      case 'registry':
        state = recordCheck(state, 'registry', registryToCheck(await options.actions.checkRegistry(state.config.registryUrl)));
        break;
      case 'resources': {
        const ports = options.requiredPorts ?? (state.config.mode === 'production' ? [80, 443] : []);
        state = recordCheck(state, 'resources', resourceToCheck(await options.actions.checkResources(ports)));
        break;
      }
      default:
        throw new HttpError(400, `Unknown check step "${step}".`);
    }
    sendJson(res, 200, snapshot());
  }

  async function handleInstall(res: ServerResponse): Promise<void> {
    let plan;
    try {
      plan = buildBootstrapPlan(state.config);
    } catch (err) {
      throw new HttpError(400, err instanceof WizardError ? err.message : 'Invalid configuration.');
    }
    const outcome = await options.actions.runInstall(plan);
    state = recordCheck(state, 'install', installToCheck(outcome));
    if (!outcome.ok) {
      sendJson(res, 200, snapshot({ outcome }));
      return;
    }
    const health = await options.actions.checkHealth(plan);
    state = recordCheck(state, 'health', healthToCheck(health));
    sendJson(res, 200, snapshot({ outcome, health, publicUrl: outcome.publicUrl }));
  }

  async function route(ctx: RequestContext, res: ServerResponse): Promise<void> {
    const path = ctx.url.pathname;

    // Persistent-mode authentication gate (everything but login + the UI shell).
    if (mode === 'persistent') {
      const isPublic = path === '/' || path === '/login' || path === '/api/login';
      if (!isPublic && !ctx.session) throw new HttpError(401, 'Authentication required.');
      // CSRF for state-changing requests on authenticated routes.
      if (ctx.session && ctx.method !== 'GET' && path !== '/api/login') {
        if (!ctx.csrf || !verifyCsrf(sessions, ctx.session.id, ctx.csrf, now())) {
          throw new HttpError(403, 'Invalid or missing CSRF token.');
        }
      }
    }

    if (path === '/api/login' && ctx.method === 'POST') return handleLogin(ctx, res);
    if (path === '/api/logout' && ctx.method === 'POST') {
      if (ctx.session) sessions = destroySession(sessions, ctx.session.id);
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }

    // Bootstrap self-lock: once complete (and not persistent), the wizard is gone.
    const bootstrapLocked = isBootstrapComplete(state) && !options.persistAfterBootstrap && mode === 'bootstrap';
    if (bootstrapLocked && path !== '/api/state') {
      throw new HttpError(410, 'Bootstrap complete. The installer UI is disabled. Enable persistent mode to manage the server.');
    }

    if (path === '/' && ctx.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(renderWizardHtml({ mode }));
      return;
    }
    if (path === '/api/state' && ctx.method === 'GET') return sendJson(res, 200, snapshot());
    if (path === '/api/config' && ctx.method === 'POST') {
      state = setConfig(state, (ctx.body ?? {}) as Partial<WizardConfig>);
      return sendJson(res, 200, snapshot());
    }
    if (path === '/api/advance' && ctx.method === 'POST') {
      try {
        state = advance(state);
      } catch (err) {
        throw new HttpError(409, err instanceof WizardError ? err.message : 'Cannot advance.');
      }
      return sendJson(res, 200, snapshot());
    }
    if (path === '/api/back' && ctx.method === 'POST') {
      state = back(state);
      return sendJson(res, 200, snapshot());
    }
    if (path.startsWith('/api/check/') && ctx.method === 'POST') {
      return runCheck(path.slice('/api/check/'.length), res);
    }
    if (path === '/api/install' && ctx.method === 'POST') return handleInstall(res);

    throw new HttpError(404, 'Not found.');
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // Low-traffic localhost admin UI: close each connection so no socket is
      // kept alive (also keeps clients from pooling stale sockets across runs).
      res.setHeader('Connection', 'close');
      try {
        if (mode === 'bootstrap' && !hostHeaderIsLocal(req)) {
          throw new HttpError(421, 'Bootstrap UI only serves localhost (DNS-rebinding guard).');
        }
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);
        const method = req.method ?? 'GET';
        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
        const body = needsBody ? await readBody(req) : undefined;
        const session = mode === 'persistent' ? await loadSession(req) : null;
        const csrf = (req.headers['x-shm-csrf'] as string | undefined) ?? null;
        await route({ url, method, body, session, csrf }, res);
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
    getState: () => state,
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
      });
    },
  };
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(text);
}
