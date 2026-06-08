// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  emptySessionTable,
  createSession,
  getSession,
  destroySession,
  pruneSessions,
  verifyCsrf,
} from './session.js';

describe('manager sessions', () => {
  it('creates a session with an id and a distinct CSRF token', () => {
    const { table, session } = createSession(emptySessionTable(), {
      operatorId: 'op-1',
      email: 'op@example.org',
      roles: ['instance_operator'],
    });
    expect(session.id).toBeTruthy();
    expect(session.csrfToken).toBeTruthy();
    expect(session.id).not.toBe(session.csrfToken);
    expect(getSession(table, session.id)?.email).toBe('op@example.org');
  });

  it('returns null for a missing or expired session', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const { table, session } = createSession(
      emptySessionTable(),
      { operatorId: 'op-1', email: 'op@example.org', roles: ['read_only'], lifetimeSeconds: 60 },
      now,
    );
    expect(getSession(table, 'nope', now)).toBeNull();
    const later = new Date(now.getTime() + 120 * 1000);
    expect(getSession(table, session.id, later)).toBeNull();
  });

  it('destroys a session and prunes expired ones', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const first = createSession(
      emptySessionTable(),
      { operatorId: 'a', email: 'a@example.org', roles: ['read_only'], lifetimeSeconds: 30 },
      now,
    );
    const second = createSession(
      first.table,
      { operatorId: 'b', email: 'b@example.org', roles: ['read_only'], lifetimeSeconds: 6000 },
      now,
    );
    const afterDestroy = destroySession(second.table, first.session.id);
    expect(getSession(afterDestroy, first.session.id, now)).toBeNull();
    expect(getSession(afterDestroy, second.session.id, now)).not.toBeNull();

    const later = new Date(now.getTime() + 60 * 1000);
    const pruned = pruneSessions(second.table, later);
    expect(getSession(pruned, second.session.id, later)).not.toBeNull();
  });

  it('verifies CSRF tokens and fails closed for mismatch/expiry', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const { table, session } = createSession(
      emptySessionTable(),
      { operatorId: 'op-1', email: 'op@example.org', roles: ['server_owner'], lifetimeSeconds: 60 },
      now,
    );
    expect(verifyCsrf(table, session.id, session.csrfToken, now)).toBe(true);
    expect(verifyCsrf(table, session.id, 'forged', now)).toBe(false);
    const later = new Date(now.getTime() + 120 * 1000);
    expect(verifyCsrf(table, session.id, session.csrfToken, later)).toBe(false);
  });
});
