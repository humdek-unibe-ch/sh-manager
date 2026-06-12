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
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, normalize, resolve } from 'node:path';
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
import { InstanceLockedError, type OperationJournal, type OperationRunner } from './jobs.js';
import type {
  CloneInstanceRequest,
  CreateInstanceRequest,
  ManagerInstanceActions,
  RemoveInstanceRequest,
  UpdateInstanceRequest,
} from './instances.js';
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
  /** Directory of the built React SPA (Vite `dist-web`). Falls back to the inline shell. */
  clientDir?: string;
  /** Manager version surfaced in every state snapshot (UI header/footer). */
  managerVersion?: string;
  /**
   * Instance lifecycle management (Workstream 2). Persistent mode only: the
   * unauthenticated bootstrap wizard NEVER exposes these APIs. All mutating
   * actions run through the operation journal + audit log + per-instance lock
   * and return `202 { operationId }`.
   */
  instanceManagement?: {
    instances: ManagerInstanceActions;
    runner: OperationRunner;
    journal: OperationJournal;
  };
  now?: () => Date;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve a file from the built SPA directory. Resolves within `clientDir` only
 * (no path traversal) and returns false when there is nothing to serve so the
 * caller can fall back to the inline shell or a 404.
 */
async function serveStatic(clientDir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const rel = normalize(urlPath).replace(/^([\\/]|\.\.[\\/])+/, '');
  const full = resolve(clientDir, rel);
  if (full !== clientDir && !full.startsWith(clientDir + (process.platform === 'win32' ? '\\' : '/'))) return false;
  if (!existsSync(full)) return false;
  const body = await readFile(full);
  res.statusCode = 200;
  res.setHeader('Content-Type', STATIC_CONTENT_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream');
  res.end(body);
  return true;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * The URL an operator can actually open for a given bind. A wildcard bind
 * (`0.0.0.0` / `::` — the in-container case, reached through a published
 * loopback port) is browsable via localhost, never via the wildcard address.
 */
export function browseUrl(host: string, port: number): string {
  const wildcard = host === '0.0.0.0' || host === '::' || host === '';
  const display = wildcard ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${display}:${port}`;
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
  /** Remote socket address, recorded in the audit log. */
  sourceIp: string | null;
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
  const clientDir = options.clientDir ? resolve(options.clientDir) : undefined;
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
      ...(options.managerVersion ? { managerVersion: options.managerVersion } : {}),
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
    // Retry after a failed attempt: the first run may already have written the
    // inventory/proxy/instance dir, so the re-run must acknowledge import/repair
    // instead of failing with "this server is already bootstrapped".
    const priorInstall = state.checks.install;
    if (priorInstall && !priorInstall.ok) {
      plan = { ...plan, serverInit: { ...plan.serverInit, allowImport: true } };
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

  async function serveAppShell(res: ServerResponse): Promise<void> {
    if (clientDir && (await serveStatic(clientDir, 'index.html', res))) return;
    // Dev / no-build fallback: the minimal inline shell.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    res.end(renderWizardHtml({ mode }));
  }

  const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

  function requireInstanceId(raw: string | undefined): string {
    if (!raw || !INSTANCE_ID_RE.test(raw)) throw new HttpError(400, 'Invalid instance id.');
    return raw;
  }

  /**
   * Instance lifecycle APIs (persistent mode only; never in bootstrap mode).
   * Reads answer directly; mutations run through the operation journal +
   * audit + per-instance lock and answer `202 { operationId }`.
   */
  async function routeInstanceManagement(ctx: RequestContext, res: ServerResponse): Promise<boolean> {
    const im = options.instanceManagement;
    if (!im || mode !== 'persistent') return false;
    const path = ctx.url.pathname;
    const operator = ctx.session?.email ?? 'unknown';

    async function start(
      kind: Parameters<OperationRunner['start']>[0]['kind'],
      instanceId: string | null,
      body: Parameters<OperationRunner['start']>[1],
    ): Promise<void> {
      try {
        const { operationId } = await im!.runner.start(
          { kind, instanceId, operator, sourceIp: ctx.sourceIp },
          body,
        );
        sendJson(res, 202, { operationId });
      } catch (err) {
        if (err instanceof InstanceLockedError) throw new HttpError(409, err.message);
        throw err;
      }
    }

    if (path === '/api/instances' && ctx.method === 'GET') {
      sendJson(res, 200, { instances: await im.instances.list() });
      return true;
    }
    if (path === '/api/instances' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as Partial<CreateInstanceRequest>;
      if (!body.instanceId || !body.displayName || !body.mode || !body.registryUrl || !body.adminEmail) {
        throw new HttpError(400, 'instanceId, displayName, mode, registryUrl and adminEmail are required.');
      }
      if (body.mode === 'production' && !body.domain) throw new HttpError(400, 'Production instances require a domain.');
      if (body.mode === 'local' && body.localPort === undefined) throw new HttpError(400, 'Local instances require a localPort.');
      const req = body as CreateInstanceRequest;
      requireInstanceId(req.instanceId);
      await start('instance_create', req.instanceId, (opCtx) => im.instances.create(req, opCtx));
      return true;
    }

    if (path === '/api/operations' && ctx.method === 'GET') {
      const instanceId = ctx.url.searchParams.get('instanceId') ?? undefined;
      sendJson(res, 200, {
        operations: await im.journal.list(instanceId !== undefined ? { instanceId } : {}),
      });
      return true;
    }
    const opMatch = path.match(/^\/api\/operations\/([a-z0-9-]+)$/i);
    if (opMatch && ctx.method === 'GET') {
      const record = await im.journal.get(opMatch[1]!);
      if (!record) throw new HttpError(404, 'Operation not found.');
      sendJson(res, 200, record);
      return true;
    }

    const m = path.match(/^\/api\/instances\/([^/]+)(\/.*)?$/);
    if (!m) return false;
    const instanceId = requireInstanceId(m[1]);
    const rest = m[2] ?? '';

    if (rest === '' && ctx.method === 'GET') {
      const detail = await im.instances.detail(instanceId);
      if (!detail) throw new HttpError(404, `Instance "${instanceId}" not found.`);
      sendJson(res, 200, detail);
      return true;
    }
    if (rest === '/backups' && ctx.method === 'GET') {
      sendJson(res, 200, { backups: await im.instances.backups(instanceId) });
      return true;
    }
    if (rest === '/health' && ctx.method === 'POST') {
      sendJson(res, 200, await im.instances.health(instanceId));
      return true;
    }
    if (rest === '/update/dry-run' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as UpdateInstanceRequest;
      sendJson(res, 200, { plan: await im.instances.updateDryRun(instanceId, body) });
      return true;
    }
    if (rest === '/update' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as UpdateInstanceRequest;
      await start('instance_update', instanceId, (opCtx) => im.instances.update(instanceId, body, opCtx));
      return true;
    }
    if (rest === '/backups' && ctx.method === 'POST') {
      await start('instance_backup', instanceId, (opCtx) => im.instances.backup(instanceId, opCtx));
      return true;
    }
    const restoreMatch = rest.match(/^\/backups\/([a-z0-9-]+)\/restore$/i);
    if (restoreMatch && ctx.method === 'POST') {
      const backupId = restoreMatch[1]!;
      await start('instance_restore', instanceId, (opCtx) => im.instances.restore(instanceId, { backupId }, opCtx));
      return true;
    }
    if (rest === '/clone' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as Partial<CloneInstanceRequest>;
      if (!body.targetInstanceId || !body.targetDomain) {
        throw new HttpError(400, 'targetInstanceId and targetDomain are required.');
      }
      requireInstanceId(body.targetInstanceId);
      const req = body as CloneInstanceRequest;
      // Lock the SOURCE instance: the clone reads its DB/volumes, so no other
      // mutation may run on it concurrently. The target does not exist yet.
      await start('instance_clone', instanceId, (opCtx) => im.instances.clone(instanceId, req, opCtx));
      return true;
    }
    if (rest === '/remove' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as Partial<RemoveInstanceRequest>;
      if (!body.mode) throw new HttpError(400, 'mode is required (disable | remove_containers_keep_data | full_delete).');
      const req = body as RemoveInstanceRequest;
      await start('instance_remove', instanceId, (opCtx) => im.instances.remove(instanceId, req, opCtx));
      return true;
    }

    return false;
  }

  async function route(ctx: RequestContext, res: ServerResponse): Promise<void> {
    const path = ctx.url.pathname;
    const isApi = path.startsWith('/api/');

    // Persistent-mode authentication gate. Only the JSON API is gated; the static
    // SPA shell + assets are always served (they contain no secrets) so the
    // sign-in screen can load before authentication.
    if (mode === 'persistent') {
      if (isApi && path !== '/api/login' && !ctx.session) throw new HttpError(401, 'Authentication required.');
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

    // Bootstrap self-lock: once complete (and not persistent), the installer can
    // no longer change anything. The SPA shell, its assets and a read-only
    // `/api/state` stay available so the browser can show the success screen.
    const bootstrapLocked = isBootstrapComplete(state) && !options.persistAfterBootstrap && mode === 'bootstrap';
    if (bootstrapLocked && ctx.method !== 'GET') {
      throw new HttpError(410, 'Bootstrap complete. The installer is disabled. Enable persistent mode to manage the server.');
    }

    // Static SPA: shell at "/", hashed assets under any other non-API GET path.
    if (ctx.method === 'GET' && !isApi) {
      if (path === '/') return serveAppShell(res);
      if (clientDir && (await serveStatic(clientDir, path, res))) return;
      // Unknown non-API path: serve the shell so the SPA can render (no client router today, but safe).
      return serveAppShell(res);
    }

    if (await routeInstanceManagement(ctx, res)) return;

    if (path === '/api/state' && ctx.method === 'GET') return sendJson(res, 200, snapshot());
    if (path === '/api/manager/update-check' && ctx.method === 'GET') {
      if (!options.actions.checkManagerUpdate) throw new HttpError(404, 'Not found.');
      return sendJson(res, 200, await options.actions.checkManagerUpdate());
    }
    if (path === '/api/registry/versions' && ctx.method === 'GET') {
      if (!options.actions.listVersions) throw new HttpError(404, 'Not found.');
      // Server-authoritative: the registry URL always comes from the wizard
      // state, never from the browser. Only the channel may be previewed (a
      // display concern; the install itself re-validates against the state).
      const channel = ctx.url.searchParams.get('channel') ?? state.config.channel;
      return sendJson(res, 200, await options.actions.listVersions(state.config.registryUrl, channel));
    }
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
