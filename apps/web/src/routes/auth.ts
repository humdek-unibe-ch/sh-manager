// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Authentication + session routes for the manager BFF: load the session from
 * the cookie, sign in (`/api/login`), and the localhost-guarded first-run
 * operator setup (`/api/setup/operator`). All three share {@link startSession},
 * which mints a session, sets the cookie and returns the CSRF token. The setup
 * route hard-locks itself once any enabled local operator exists.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authenticateLocal,
  createOperator,
  createSession,
  getSession,
  isBootstrapRequired,
  validatePasswordStrength,
  type ManagerSession,
} from '@shm/auth';
import { HttpError, sendJson } from '../http/respond.js';
import { SESSION_COOKIE, parseCookies } from '../http/cookies.js';
import type { RequestContext, ServerCtx } from './context.js';

export async function loadSession(srv: ServerCtx, req: IncomingMessage): Promise<ManagerSession | null> {
  const cookies = parseCookies(req.headers.cookie);
  const id = cookies[SESSION_COOKIE];
  if (!id) return null;
  return getSession(srv.sessions, id, srv.now());
}

function startSession(
  srv: ServerCtx,
  res: ServerResponse,
  operator: { id: string; email: string; roles: ManagerSession['roles'] },
): void {
  const created = createSession(
    srv.sessions,
    {
      operatorId: operator.id,
      email: operator.email,
      roles: operator.roles,
      ...(srv.options.sessionLifetimeSeconds ? { lifetimeSeconds: srv.options.sessionLifetimeSeconds } : {}),
    },
    srv.now(),
  );
  srv.sessions = created.table;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${created.session.id}; HttpOnly; SameSite=Strict; Path=/`);
  sendJson(res, 200, {
    ok: true,
    email: created.session.email,
    roles: created.session.roles,
    csrfToken: created.session.csrfToken,
  });
}

export async function handleLogin(srv: ServerCtx, ctx: RequestContext, res: ServerResponse): Promise<void> {
  const body = (ctx.body ?? {}) as { email?: string; password?: string };
  if (!body.email || !body.password) throw new HttpError(400, 'Email and password are required.');
  const table = await srv.options.operatorStore.load();
  const result = authenticateLocal(table, body.email, body.password);
  if (!result.ok || !result.operator) throw new HttpError(401, result.reason ?? 'Invalid credentials.');
  startSession(srv, res, result.operator);
}

/**
 * First-run setup: create the FIRST operator account from the (localhost)
 * sign-in screen, then sign them in. Hard requirement: available only while
 * NO enabled local operator exists — afterwards it permanently answers 409,
 * so it can never be used to add accounts to a configured manager.
 */
export async function handleSetupOperator(srv: ServerCtx, ctx: RequestContext, res: ServerResponse): Promise<void> {
  const body = (ctx.body ?? {}) as { email?: string; displayName?: string; password?: string };
  const table = await srv.options.operatorStore.load();
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
  await srv.options.operatorStore.save(created.table);
  startSession(srv, res, created.operator);
}
