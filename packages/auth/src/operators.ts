// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Local manager-operator registry.
 *
 * Holds the set of people allowed to operate the SelfHelp Manager: local
 * password operators (created on first run or via the CLI) and the OIDC
 * email allowlist. The table is a plain serialisable structure so it can be
 * persisted atomically with restrictive permissions; raw passwords are never
 * stored (only scrypt digests via {@link hashPassword}).
 *
 * First-run bootstrap: when no enabled local operator exists, the manager web
 * UI is locked behind a one-time bootstrap token (a high-entropy random string
 * printed once on the CLI/stdout and stored only as a SHA-256 hash). The token
 * lets the very first operator be created, then it is consumed.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ManagerRole } from './config.js';
import { MANAGER_ROLES } from './config.js';
import { hashPassword, verifyPassword } from './password.js';

export type OperatorSource = 'local' | 'oidc';

export interface ManagerOperator {
  id: string;
  email: string;
  displayName: string;
  /** scrypt digest for local operators; null for OIDC-only identities. */
  passwordHash: string | null;
  roles: ManagerRole[];
  disabled: boolean;
  source: OperatorSource;
  createdAt: string;
  updatedAt: string;
}

export interface BootstrapToken {
  /** SHA-256 hex of the one-time token; never the token itself. */
  hash: string;
  createdAt: string;
  expiresAt: string;
}

export interface OperatorTable {
  version: 1;
  operators: ManagerOperator[];
  /** Extra emails (beyond mapped operators) allowed to log in via OIDC. */
  allowedEmails: string[];
  bootstrapToken: BootstrapToken | null;
}

export interface OperatorStore {
  load(): Promise<OperatorTable>;
  save(table: OperatorTable): Promise<void>;
}

export function emptyOperatorTable(): OperatorTable {
  return { version: 1, operators: [], allowedEmails: [], bootstrapToken: null };
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function findOperatorByEmail(table: OperatorTable, email: string): ManagerOperator | undefined {
  const target = normaliseEmail(email);
  return table.operators.find((o) => o.email === target);
}

/** True when no ENABLED local operator exists, so first-run bootstrap applies. */
export function isBootstrapRequired(table: OperatorTable): boolean {
  return !table.operators.some((o) => o.source === 'local' && !o.disabled);
}

export interface BootstrapTokenIssue {
  table: OperatorTable;
  /** The plaintext token — show once, never persisted. */
  token: string;
}

export function createBootstrapToken(
  table: OperatorTable,
  now: Date = new Date(),
  ttlSeconds = 3600,
): BootstrapTokenIssue {
  const token = randomBytes(32).toString('base64url');
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  return {
    token,
    table: { ...table, bootstrapToken: { hash: sha256Hex(token), createdAt, expiresAt } },
  };
}

export function verifyBootstrapToken(table: OperatorTable, token: string, now: Date = new Date()): boolean {
  const bt = table.bootstrapToken;
  if (!bt) return false;
  if (new Date(bt.expiresAt).getTime() <= now.getTime()) return false;
  return constantTimeEqualHex(bt.hash, sha256Hex(token));
}

export function consumeBootstrapToken(table: OperatorTable): OperatorTable {
  return { ...table, bootstrapToken: null };
}

export interface CreateOperatorInput {
  email: string;
  displayName: string;
  password?: string;
  roles: ManagerRole[];
  source?: OperatorSource;
}

export interface OperatorResult {
  table: OperatorTable;
  operator: ManagerOperator;
}

function assertRoles(roles: ManagerRole[]): void {
  for (const r of roles) {
    if (!MANAGER_ROLES.includes(r)) throw new Error(`Unknown manager role "${r}".`);
  }
}

export function createOperator(
  table: OperatorTable,
  input: CreateOperatorInput,
  now: Date = new Date(),
): OperatorResult {
  const email = normaliseEmail(input.email);
  if (!email || !email.includes('@')) throw new Error('A valid email is required.');
  if (findOperatorByEmail(table, email)) throw new Error(`An operator with email ${email} already exists.`);
  assertRoles(input.roles);
  if (input.roles.length === 0) throw new Error('At least one role is required.');

  const source: OperatorSource = input.source ?? 'local';
  if (source === 'local' && !input.password) {
    throw new Error('A password is required for a local operator.');
  }

  const ts = now.toISOString();
  const operator: ManagerOperator = {
    id: randomUUID(),
    email,
    displayName: input.displayName.trim() || email,
    passwordHash: input.password ? hashPassword(input.password) : null,
    roles: [...new Set(input.roles)],
    disabled: false,
    source,
    createdAt: ts,
    updatedAt: ts,
  };
  return { table: { ...table, operators: [...table.operators, operator] }, operator };
}

function updateOperator(
  table: OperatorTable,
  email: string,
  mutate: (op: ManagerOperator) => ManagerOperator,
  now: Date,
): OperatorTable {
  const target = normaliseEmail(email);
  let found = false;
  const operators = table.operators.map((o) => {
    if (o.email !== target) return o;
    found = true;
    return { ...mutate(o), updatedAt: now.toISOString() };
  });
  if (!found) throw new Error(`No operator with email ${target}.`);
  return { ...table, operators };
}

export function disableOperator(table: OperatorTable, email: string, now: Date = new Date()): OperatorTable {
  return updateOperator(table, email, (o) => ({ ...o, disabled: true }), now);
}

export function enableOperator(table: OperatorTable, email: string, now: Date = new Date()): OperatorTable {
  return updateOperator(table, email, (o) => ({ ...o, disabled: false }), now);
}

export function grantRole(table: OperatorTable, email: string, role: ManagerRole, now: Date = new Date()): OperatorTable {
  assertRoles([role]);
  return updateOperator(table, email, (o) => ({ ...o, roles: [...new Set([...o.roles, role])] }), now);
}

export function revokeRole(table: OperatorTable, email: string, role: ManagerRole, now: Date = new Date()): OperatorTable {
  return updateOperator(
    table,
    email,
    (o) => {
      const roles = o.roles.filter((r) => r !== role);
      if (roles.length === 0) throw new Error('Cannot remove the last role from an operator; disable them instead.');
      return { ...o, roles };
    },
    now,
  );
}

export function setPassword(table: OperatorTable, email: string, password: string, now: Date = new Date()): OperatorTable {
  return updateOperator(table, email, (o) => ({ ...o, passwordHash: hashPassword(password), source: 'local' }), now);
}

export function addAllowedEmail(table: OperatorTable, email: string): OperatorTable {
  const target = normaliseEmail(email);
  if (!target.includes('@')) throw new Error('A valid email is required.');
  if (table.allowedEmails.includes(target)) return table;
  return { ...table, allowedEmails: [...table.allowedEmails, target] };
}

export function removeAllowedEmail(table: OperatorTable, email: string): OperatorTable {
  const target = normaliseEmail(email);
  return { ...table, allowedEmails: table.allowedEmails.filter((e) => e !== target) };
}

export interface LocalAuthResult {
  ok: boolean;
  operator?: ManagerOperator;
  reason?: string;
}

/** Authenticate a local operator by email + password (constant-time verify). */
export function authenticateLocal(table: OperatorTable, email: string, password: string): LocalAuthResult {
  const operator = findOperatorByEmail(table, email);
  if (!operator || operator.source !== 'local' || !operator.passwordHash) {
    // Spend a verify cycle against a dummy hash to reduce user-enumeration timing signal.
    verifyPassword(password, 'scrypt$16384$8$1$64$AAAA$AAAA');
    return { ok: false, reason: 'Invalid credentials.' };
  }
  if (operator.disabled) {
    return { ok: false, reason: 'Operator is disabled.' };
  }
  if (!verifyPassword(password, operator.passwordHash)) {
    return { ok: false, reason: 'Invalid credentials.' };
  }
  return { ok: true, operator };
}
