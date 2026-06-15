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
 * {@link ManagerInstanceActions}.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, normalize, resolve } from 'node:path';
import type { BackupSchedulePolicy } from '@shm/schemas';
import { validateSchedulePolicy } from '@shm/backup';
import type { OperatorStore } from '@shm/auth';
import {
  authenticateLocal,
  createOperator,
  createSession,
  destroySession,
  emptySessionTable,
  getSession,
  isBootstrapRequired,
  validatePasswordStrength,
  verifyCsrf,
  type ManagerSession,
  type SessionTable,
} from '@shm/auth';
import {
  dockerToCheck,
  registryToCheck,
  resourceToCheck,
  type BootstrapActions,
  type CheckResult,
} from './actions.js';
import { InstanceLockedError, type OperationJournal, type OperationRunner } from './jobs.js';
import {
  MAILER_DSN_RE,
  validateAddressChange,
  validateCloneInstance,
  validateCreateInstance,
} from './instance-validation.js';
import { LOG_SERVICES } from './instances.js';
import type {
  CloneInstanceRequest,
  CreateInstanceRequest,
  FrontendUpdateInstanceRequest,
  LogService,
  ManagerInstanceActions,
  RemoveInstanceRequest,
  SetAddressRequest,
  SetEnvRequest,
  SetMailerRequest,
  SetNameRequest,
  UpdateInstanceRequest,
} from './instances.js';

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

/** Minimal page served when the built SPA is missing (dev / broken image). */
const FALLBACK_SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>SelfHelp Manager</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto;">
<h1>SelfHelp Manager</h1>
<p>The web console assets are not built. Run <code>npm run build</code> (or use the official
<code>sh-manager</code> Docker image) and reload this page.</p>
</body></html>`;

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

  function startSession(res: ServerResponse, operator: { id: string; email: string; roles: ManagerSession['roles'] }): void {
    const created = createSession(
      sessions,
      {
        operatorId: operator.id,
        email: operator.email,
        roles: operator.roles,
        ...(options.sessionLifetimeSeconds ? { lifetimeSeconds: options.sessionLifetimeSeconds } : {}),
      },
      now(),
    );
    sessions = created.table;
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${created.session.id}; HttpOnly; SameSite=Strict; Path=/`);
    sendJson(res, 200, {
      ok: true,
      email: created.session.email,
      roles: created.session.roles,
      csrfToken: created.session.csrfToken,
    });
  }

  async function handleLogin(ctx: RequestContext, res: ServerResponse): Promise<void> {
    const body = (ctx.body ?? {}) as { email?: string; password?: string };
    if (!body.email || !body.password) throw new HttpError(400, 'Email and password are required.');
    const table = await options.operatorStore.load();
    const result = authenticateLocal(table, body.email, body.password);
    if (!result.ok || !result.operator) throw new HttpError(401, result.reason ?? 'Invalid credentials.');
    startSession(res, result.operator);
  }

  /**
   * First-run setup: create the FIRST operator account from the (localhost)
   * sign-in screen, then sign them in. Hard requirement: available only while
   * NO enabled local operator exists — afterwards it permanently answers 409,
   * so it can never be used to add accounts to a configured manager.
   */
  async function handleSetupOperator(ctx: RequestContext, res: ServerResponse): Promise<void> {
    const body = (ctx.body ?? {}) as { email?: string; displayName?: string; password?: string };
    const table = await options.operatorStore.load();
    if (!isBootstrapRequired(table)) {
      throw new HttpError(409, 'Operators already exist. Sign in instead (or use `sh-manager admin create`).');
    }
    if (!body.email || !body.password) throw new HttpError(400, 'Email and password are required.');
    const strength = validatePasswordStrength(body.password);
    if (!strength.ok) throw new HttpError(400, strength.reason ?? 'Password too weak.');
    let created;
    try {
      created = createOperator(table, {
        email: body.email,
        displayName: body.displayName ?? body.email,
        password: body.password,
        roles: ['server_owner'],
      });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'Could not create operator.');
    }
    await options.operatorStore.save(created.table);
    startSession(res, created.operator);
  }

  async function serveAppShell(res: ServerResponse): Promise<void> {
    if (clientDir && (await serveStatic(clientDir, 'index.html', res))) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    res.end(FALLBACK_SHELL);
  }

  /**
   * Stateless preflight: the same checks the old bootstrap wizard ran, but
   * executed on demand for the create-instance wizard. Production mode also
   * verifies ports 80/443 are usable (the proxy needs them).
   */
  async function handlePreflight(ctx: RequestContext, res: ServerResponse): Promise<void> {
    const body = (ctx.body ?? {}) as { mode?: string; registryUrl?: string };
    const registryUrl = body.registryUrl && /^https?:\/\//.test(body.registryUrl) ? body.registryUrl : defaultRegistryUrl;
    const ports = body.mode === 'production' ? [80, 443] : [];
    const [docker, internet, registry, resources] = await Promise.all([
      options.actions.checkDocker().then(dockerToCheck, toErrorCheck),
      options.actions.checkInternet().catch(toErrorCheck),
      options.actions.checkRegistry(registryUrl).then(registryToCheck, toErrorCheck),
      options.actions.checkResources(ports).then(resourceToCheck, toErrorCheck),
    ]);
    sendJson(res, 200, { docker, internet, registry, resources, registryUrl });
  }

  // Lowercase only — matches the create-form/wizard validation and the CLI's
  // on-disk layout (compose project names + paths are lowercase).
  const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

  function requireInstanceId(raw: string | undefined): string {
    if (!raw || !INSTANCE_ID_RE.test(raw)) throw new HttpError(400, 'Invalid instance id.');
    return raw;
  }

  /**
   * Instance lifecycle APIs. Reads answer directly; mutations run through the
   * operation journal + audit + per-instance lock and answer `202 { operationId }`.
   */
  async function routeInstanceManagement(ctx: RequestContext, res: ServerResponse): Promise<boolean> {
    const im = options.instanceManagement;
    if (!im) return false;
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

    if (path === '/api/server/status' && ctx.method === 'GET') {
      sendJson(res, 200, await im.instances.serverStatus());
      return true;
    }
    if (path === '/api/server/preflight' && ctx.method === 'POST') {
      await handlePreflight(ctx, res);
      return true;
    }

    if (path === '/api/instances' && ctx.method === 'GET') {
      sendJson(res, 200, { instances: await im.instances.list() });
      return true;
    }
    if (path === '/api/instances' && ctx.method === 'POST') {
      // Server-authoritative registry: the official registry is the default;
      // a custom URL must at least be http(s).
      const body = { registryUrl: defaultRegistryUrl, ...((ctx.body ?? {}) as Partial<CreateInstanceRequest>) };
      if (!/^https?:\/\//.test(body.registryUrl)) throw new HttpError(400, 'registryUrl must be http(s).');
      // Same rules the create wizard enforces field-by-field (shared module),
      // re-checked server-side so the API cannot be driven past them.
      const problems = validateCreateInstance(body);
      if (problems.length > 0) throw new HttpError(400, problems.join(' '));
      const req = body as CreateInstanceRequest;
      await start('instance_create', req.instanceId, (opCtx) => im.instances.create(req, opCtx));
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
    if (rest === '/backup-schedule' && ctx.method === 'GET') {
      sendJson(res, 200, await im.instances.backupSchedule(instanceId));
      return true;
    }
    if (rest === '/backup-schedule' && ctx.method === 'PUT') {
      // Server-authoritative validation: the client must send a complete,
      // well-formed policy; anything else is rejected with the exact problems.
      const raw = (ctx.body ?? {}) as Partial<BackupSchedulePolicy>;
      const policy: BackupSchedulePolicy = {
        enabled: raw.enabled as boolean,
        time: raw.time as string,
        retention: {
          daily: raw.retention?.daily as number,
          weekly: raw.retention?.weekly as number,
          monthly: raw.retention?.monthly as number,
          maxAgeDays: raw.retention?.maxAgeDays as number,
        },
      };
      const problems = validateSchedulePolicy(policy);
      if (problems.length > 0) throw new HttpError(400, problems.join(' '));
      sendJson(res, 200, await im.instances.setBackupSchedule(instanceId, policy));
      return true;
    }
    if (rest === '/backup-prune' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as { dryRun?: boolean };
      if (body.dryRun === true) {
        // Read-only preview: plan without deleting anything.
        sendJson(res, 200, await im.instances.backupPrunePlan(instanceId));
        return true;
      }
      await start('instance_backup_prune', instanceId, (opCtx) => im.instances.backupPrune(instanceId, opCtx));
      return true;
    }
    if (rest === '/health' && ctx.method === 'POST') {
      sendJson(res, 200, await im.instances.health(instanceId));
      return true;
    }
    if (rest === '/mailer' && ctx.method === 'GET') {
      sendJson(res, 200, await im.instances.mailer(instanceId));
      return true;
    }
    if (rest === '/mailer' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as Partial<SetMailerRequest>;
      const clearing = body.clear === true || body.dsn === undefined || body.dsn === '';
      if (!clearing && !MAILER_DSN_RE.test(body.dsn!)) {
        throw new HttpError(400, 'Mailer DSN must look like scheme://… (e.g. smtp://user:pass@mail.example.org:587).');
      }
      const req = body as SetMailerRequest;
      await start('instance_set_mailer', instanceId, (opCtx) => im.instances.setMailer(instanceId, req, opCtx));
      return true;
    }
    if (rest === '/name' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as Partial<SetNameRequest>;
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      if (displayName === '') throw new HttpError(400, 'A display name is required.');
      if (displayName.length > 200) throw new HttpError(400, 'Display name is too long (max 200 characters).');
      const req: SetNameRequest = { displayName };
      await start('instance_set_name', instanceId, (opCtx) => im.instances.setName(instanceId, req, opCtx));
      return true;
    }
    if (rest === '/env' && ctx.method === 'GET') {
      sendJson(res, 200, await im.instances.envConfig(instanceId));
      return true;
    }
    if (rest === '/logs' && ctx.method === 'GET') {
      const serviceParam = ctx.url.searchParams.get('service') ?? 'backend';
      if (!(LOG_SERVICES as readonly string[]).includes(serviceParam)) {
        throw new HttpError(400, `Unknown service "${serviceParam}". Choose one of: ${LOG_SERVICES.join(', ')}.`);
      }
      const tailRaw = ctx.url.searchParams.get('tail');
      const tail = tailRaw !== null && tailRaw !== '' ? Number(tailRaw) : undefined;
      if (tail !== undefined && !Number.isFinite(tail)) {
        throw new HttpError(400, 'tail must be a number.');
      }
      sendJson(res, 200, await im.instances.logs(instanceId, { service: serviceParam as LogService, tail }));
      return true;
    }
    if (rest === '/env' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as Partial<SetEnvRequest>;
      const overrides = body.overrides;
      if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new HttpError(400, 'overrides must be an object of KEY=value pairs.');
      }
      for (const [key, value] of Object.entries(overrides)) {
        if (typeof value !== 'string') {
          throw new HttpError(400, `The value for ${key} must be a string.`);
        }
      }
      const req = { overrides } as SetEnvRequest;
      await start('instance_set_env', instanceId, (opCtx) => im.instances.setEnv(instanceId, req, opCtx));
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
    if (rest === '/frontend-update/dry-run' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as FrontendUpdateInstanceRequest;
      sendJson(res, 200, { plan: await im.instances.frontendUpdateDryRun(instanceId, body) });
      return true;
    }
    if (rest === '/frontend-update' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as FrontendUpdateInstanceRequest;
      await start('instance_frontend_update', instanceId, (opCtx) => im.instances.frontendUpdate(instanceId, body, opCtx));
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
      // Mode-aware requirements: a production source needs a NEW domain, a
      // local source a NEW localhost port. The source's mode comes from its
      // manifest — never from the client.
      const detail = await im.instances.detail(instanceId);
      if (!detail) throw new HttpError(404, `Instance "${instanceId}" not found.`);
      const sourceMode = detail.summary.mode === 'local' ? 'local' : 'production';
      const problems = validateCloneInstance({
        sourceInstanceId: instanceId,
        sourceMode,
        sourceDomain: detail.summary.domain,
        ...(body.targetInstanceId ? { targetInstanceId: body.targetInstanceId } : {}),
        ...(body.targetDomain ? { targetDomain: body.targetDomain } : {}),
        ...(body.targetLocalPort !== undefined ? { targetLocalPort: body.targetLocalPort } : {}),
      });
      if (problems.length > 0) throw new HttpError(400, problems.join(' '));
      const req = body as CloneInstanceRequest;
      // Lock the SOURCE instance: the clone reads its DB/volumes, so no other
      // mutation may run on it concurrently. The target does not exist yet.
      await start('instance_clone', instanceId, (opCtx) => im.instances.clone(instanceId, req, opCtx));
      return true;
    }
    if (rest === '/address' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as Partial<SetAddressRequest>;
      const detail = await im.instances.detail(instanceId);
      if (!detail) throw new HttpError(404, `Instance "${instanceId}" not found.`);
      const mode = detail.summary.mode === 'local' ? 'local' : 'production';
      const problems = validateAddressChange({
        mode,
        ...(body.domain ? { domain: body.domain } : {}),
        ...(body.localPort !== undefined ? { localPort: body.localPort } : {}),
      });
      if (problems.length > 0) throw new HttpError(400, problems.join(' '));
      const req = body as SetAddressRequest;
      await start('instance_set_address', instanceId, (opCtx) => im.instances.setAddress(instanceId, req, opCtx));
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
      if (!ctx.csrf || !verifyCsrf(sessions, ctx.session.id, ctx.csrf, now())) {
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
    if (path === '/api/login' && ctx.method === 'POST') return handleLogin(ctx, res);
    if (path === '/api/setup/operator' && ctx.method === 'POST') return handleSetupOperator(ctx, res);
    if (path === '/api/logout' && ctx.method === 'POST') {
      if (ctx.session) sessions = destroySession(sessions, ctx.session.id);
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }

    // Operations endpoints (journal reads).
    if (options.instanceManagement) {
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
      if (path === '/') return serveAppShell(res);
      if (clientDir && (await serveStatic(clientDir, path, res))) return;
      // Unknown non-API path: serve the shell so the SPA can render (no client router today, but safe).
      return serveAppShell(res);
    }

    if (await routeInstanceManagement(ctx, res)) return;

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
        const session = await loadSession(req);
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
      });
    },
  };
}

function toErrorCheck(err: unknown): CheckResult {
  return { ok: false, severity: 'error', detail: err instanceof Error ? err.message : String(err) };
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
