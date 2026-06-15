// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  emptyOperatorTable,
  isBootstrapRequired,
  createBootstrapToken,
  verifyBootstrapToken,
  consumeBootstrapToken,
  createOperator,
  disableOperator,
  grantRole,
  revokeRole,
  authenticateLocal,
  findOperatorByEmail,
} from './operators.js';

const STRONG = 'correct horse battery staple';

describe('first-run bootstrap', () => {
  it('requires bootstrap when no enabled local operator exists', () => {
    expect(isBootstrapRequired(emptyOperatorTable())).toBe(true);
  });

  it('issues a one-time token stored only as a hash, and verifies it', () => {
    const { table, token } = createBootstrapToken(emptyOperatorTable());
    expect(token).toBeTruthy();
    expect(table.bootstrapToken?.hash).toBeTruthy();
    expect(table.bootstrapToken?.hash).not.toContain(token);
    expect(verifyBootstrapToken(table, token)).toBe(true);
    expect(verifyBootstrapToken(table, 'wrong-token')).toBe(false);
  });

  it('rejects an expired token and a consumed token', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const { table, token } = createBootstrapToken(emptyOperatorTable(), now, 60);
    const later = new Date(now.getTime() + 120 * 1000);
    expect(verifyBootstrapToken(table, token, later)).toBe(false);
    const consumed = consumeBootstrapToken(table);
    expect(verifyBootstrapToken(consumed, token, now)).toBe(false);
  });

  it('no longer requires bootstrap after the first local operator is created', () => {
    const { table } = createOperator(emptyOperatorTable(), {
      email: 'owner@example.org',
      displayName: 'Owner',
      password: STRONG,
      roles: ['server_owner'],
    });
    expect(isBootstrapRequired(table)).toBe(false);
  });
});

describe('operator lifecycle', () => {
  it('creates, normalises email, and rejects duplicates', () => {
    const { table, operator } = createOperator(emptyOperatorTable(), {
      email: 'Owner@Example.org',
      displayName: 'Owner',
      password: STRONG,
      roles: ['server_owner'],
    });
    expect(operator.email).toBe('owner@example.org');
    expect(operator.passwordHash).not.toBeNull();
    expect(operator.passwordHash).not.toContain(STRONG);
    expect(() =>
      createOperator(table, { email: 'owner@example.org', displayName: 'Dup', password: STRONG, roles: ['read_only'] }),
    ).toThrow(/already exists/);
  });

  it('requires a password for a local operator', () => {
    expect(() =>
      createOperator(emptyOperatorTable(), { email: 'x@example.org', displayName: 'X', roles: ['read_only'] }),
    ).toThrow(/password/i);
  });

  it('grants and revokes roles but never removes the last one', () => {
    let { table } = createOperator(emptyOperatorTable(), {
      email: 'op@example.org',
      displayName: 'Op',
      password: STRONG,
      roles: ['instance_operator'],
    });
    table = grantRole(table, 'op@example.org', 'read_only');
    expect(findOperatorByEmail(table, 'op@example.org')?.roles).toEqual(['instance_operator', 'read_only']);
    table = revokeRole(table, 'op@example.org', 'read_only');
    expect(findOperatorByEmail(table, 'op@example.org')?.roles).toEqual(['instance_operator']);
    expect(() => revokeRole(table, 'op@example.org', 'instance_operator')).toThrow(/last role/);
  });

  it('rejects unknown roles', () => {
    expect(() =>
      createOperator(emptyOperatorTable(), {
        email: 'op@example.org',
        displayName: 'Op',
        password: STRONG,
        // @ts-expect-error intentionally invalid role
        roles: ['superuser'],
      }),
    ).toThrow(/Unknown manager role/);
  });
});

describe('local authentication', () => {
  it('authenticates a valid operator and rejects bad/disabled ones', () => {
    let { table } = createOperator(emptyOperatorTable(), {
      email: 'op@example.org',
      displayName: 'Op',
      password: STRONG,
      roles: ['instance_operator'],
    });
    expect(authenticateLocal(table, 'op@example.org', STRONG).ok).toBe(true);
    expect(authenticateLocal(table, 'op@example.org', 'wrong-password!!').ok).toBe(false);
    expect(authenticateLocal(table, 'missing@example.org', STRONG).ok).toBe(false);

    table = disableOperator(table, 'op@example.org');
    const disabled = authenticateLocal(table, 'op@example.org', STRONG);
    expect(disabled.ok).toBe(false);
    expect(disabled.reason).toMatch(/disabled/i);
  });
});
