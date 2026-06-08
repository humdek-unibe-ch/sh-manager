// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Manager operator administration (CLI-facing).
 *
 * Thin, store-backed actions for managing local operators and the OIDC email
 * allowlist. Each action loads the {@link OperatorTable}, applies a pure
 * mutation from `@shm/auth`, and persists it atomically. The store is injected
 * so these are unit-testable without touching disk.
 */
import path from 'node:path';
import {
  FileOperatorStore,
  MANAGER_ROLES,
  addAllowedEmail,
  createBootstrapToken,
  createOperator,
  disableOperator,
  grantRole,
  type ManagerOperator,
  type ManagerRole,
  type OperatorStore,
} from '@shm/auth';

/** Canonical on-disk location of the operator registry for a SelfHelp root. */
export function operatorStorePath(root: string): string {
  return path.join(root, 'manager', 'operators.json');
}

export function fileOperatorStore(root: string): OperatorStore {
  return new FileOperatorStore(operatorStorePath(root));
}

/** Parse a comma-separated `--roles` value into validated manager roles. */
export function parseRoles(input: string): ManagerRole[] {
  const roles = input
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (roles.length === 0) throw new Error('At least one role is required (--roles).');
  for (const r of roles) {
    if (!MANAGER_ROLES.includes(r as ManagerRole)) {
      throw new Error(`Unknown manager role "${r}". Valid roles: ${MANAGER_ROLES.join(', ')}.`);
    }
  }
  return roles as ManagerRole[];
}

/** Operator view safe for printing — never includes the password digest. */
export interface RedactedOperator {
  email: string;
  displayName: string;
  roles: ManagerRole[];
  disabled: boolean;
  source: ManagerOperator['source'];
}

function redact(op: ManagerOperator): RedactedOperator {
  return { email: op.email, displayName: op.displayName, roles: op.roles, disabled: op.disabled, source: op.source };
}

export interface AdminCreateInput {
  email: string;
  displayName: string;
  password: string;
  roles: ManagerRole[];
}

export async function adminCreate(store: OperatorStore, input: AdminCreateInput, now?: Date): Promise<RedactedOperator> {
  const table = await store.load();
  const { table: next, operator } = createOperator(
    table,
    { email: input.email, displayName: input.displayName, password: input.password, roles: input.roles, source: 'local' },
    now,
  );
  await store.save(next);
  return redact(operator);
}

export async function adminDisable(store: OperatorStore, email: string, now?: Date): Promise<void> {
  await store.save(disableOperator(await store.load(), email, now));
}

export async function adminRoleGrant(store: OperatorStore, email: string, role: ManagerRole, now?: Date): Promise<void> {
  if (!MANAGER_ROLES.includes(role)) {
    throw new Error(`Unknown manager role "${role}". Valid roles: ${MANAGER_ROLES.join(', ')}.`);
  }
  await store.save(grantRole(await store.load(), email, role, now));
}

export async function adminAllowEmailAdd(store: OperatorStore, email: string): Promise<void> {
  await store.save(addAllowedEmail(await store.load(), email));
}

export async function adminList(store: OperatorStore): Promise<RedactedOperator[]> {
  const table = await store.load();
  return table.operators.map(redact);
}

/**
 * Issue a one-time bootstrap token (printed once). Used to unlock first-run
 * operator creation in the web UI when no local operator exists yet.
 */
export async function adminBootstrapToken(store: OperatorStore, ttlSeconds = 3600, now?: Date): Promise<string> {
  const { table, token } = createBootstrapToken(await store.load(), now ?? new Date(), ttlSeconds);
  await store.save(table);
  return token;
}
