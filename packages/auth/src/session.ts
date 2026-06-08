// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Manager session + CSRF token management.
 *
 * Sessions are opaque high-entropy ids bound to an operator with an absolute
 * expiry. Each session carries a CSRF token that state-changing requests must
 * echo (double-submit / synchroniser pattern). Everything is in-memory data so
 * it stays unit-testable; a process keeps a single {@link SessionTable} that
 * the HTTP layer owns. Session secrets are NEVER written to `.env` — they only
 * live in memory (and, if a deployment chooses, a restricted runtime store).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ManagerRole } from './config.js';

export interface ManagerSession {
  id: string;
  operatorId: string;
  email: string;
  roles: ManagerRole[];
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface SessionTable {
  sessions: Record<string, ManagerSession>;
}

export const DEFAULT_SESSION_LIFETIME_SECONDS = 8 * 3600;

export function emptySessionTable(): SessionTable {
  return { sessions: {} };
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export interface CreateSessionInput {
  operatorId: string;
  email: string;
  roles: ManagerRole[];
  lifetimeSeconds?: number;
}

export interface CreatedSession {
  table: SessionTable;
  session: ManagerSession;
}

export function createSession(
  table: SessionTable,
  input: CreateSessionInput,
  now: Date = new Date(),
): CreatedSession {
  const lifetime = input.lifetimeSeconds ?? DEFAULT_SESSION_LIFETIME_SECONDS;
  const session: ManagerSession = {
    id: token(32),
    operatorId: input.operatorId,
    email: input.email,
    roles: input.roles,
    csrfToken: token(32),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + lifetime * 1000).toISOString(),
  };
  return {
    session,
    table: { sessions: { ...table.sessions, [session.id]: session } },
  };
}

/** Returns the live session for an id, or null when missing/expired. */
export function getSession(table: SessionTable, sessionId: string, now: Date = new Date()): ManagerSession | null {
  if (!sessionId) return null;
  const session = table.sessions[sessionId];
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= now.getTime()) return null;
  return session;
}

export function destroySession(table: SessionTable, sessionId: string): SessionTable {
  if (!(sessionId in table.sessions)) return table;
  const next = { ...table.sessions };
  delete next[sessionId];
  return { sessions: next };
}

/** Drops every expired session (housekeeping). */
export function pruneSessions(table: SessionTable, now: Date = new Date()): SessionTable {
  const next: Record<string, ManagerSession> = {};
  for (const [id, s] of Object.entries(table.sessions)) {
    if (new Date(s.expiresAt).getTime() > now.getTime()) next[id] = s;
  }
  return { sessions: next };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify a CSRF token against the live session in constant time. A missing or
 * expired session fails closed.
 */
export function verifyCsrf(
  table: SessionTable,
  sessionId: string,
  csrfToken: string,
  now: Date = new Date(),
): boolean {
  const session = getSession(table, sessionId, now);
  if (!session || !csrfToken) return false;
  return constantTimeEqual(session.csrfToken, csrfToken);
}
