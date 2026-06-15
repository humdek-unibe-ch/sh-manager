// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { InMemoryOperatorStore, authenticateLocal, verifyBootstrapToken } from '@shm/auth';
import {
  adminBootstrapToken,
  adminCreate,
  adminDisable,
  adminList,
  adminRoleGrant,
  operatorStorePath,
  parseRoles,
} from './admin.js';

describe('parseRoles', () => {
  it('parses and trims a comma-separated role list', () => {
    expect(parseRoles('server_owner, read_only')).toEqual(['server_owner', 'read_only']);
  });

  it('rejects unknown roles', () => {
    expect(() => parseRoles('root')).toThrow(/Unknown manager role/);
  });

  it('rejects an empty role list', () => {
    expect(() => parseRoles('  ')).toThrow(/At least one role/);
  });
});

describe('operatorStorePath', () => {
  it('derives the store path from the SelfHelp root', () => {
    expect(operatorStorePath('/opt/selfhelp').replace(/\\/g, '/')).toBe('/opt/selfhelp/manager/operators.json');
  });
});

describe('admin operator lifecycle', () => {
  it('creates a local operator whose redacted view never exposes the password digest', async () => {
    const store = new InMemoryOperatorStore();
    const op = await adminCreate(store, {
      email: 'Owner@Example.org',
      displayName: 'Owner',
      password: 'correct horse battery staple',
      roles: ['server_owner'],
    });
    expect(op.email).toBe('owner@example.org');
    expect(op.roles).toEqual(['server_owner']);
    expect(op.disabled).toBe(false);
    expect(Object.keys(op)).not.toContain('passwordHash');

    // Persisted operator can authenticate locally.
    const table = await store.load();
    expect(authenticateLocal(table, 'owner@example.org', 'correct horse battery staple').ok).toBe(true);
  });

  it('grants roles, disables, and lists operators', async () => {
    const store = new InMemoryOperatorStore();
    await adminCreate(store, { email: 'op@example.org', displayName: 'Op', password: 'a strong passphrase here', roles: ['read_only'] });
    await adminRoleGrant(store, 'op@example.org', 'instance_operator');
    let list = await adminList(store);
    expect(list[0]?.roles).toEqual(['read_only', 'instance_operator']);

    await adminDisable(store, 'op@example.org');
    list = await adminList(store);
    expect(list[0]?.disabled).toBe(true);
    // A disabled operator can no longer authenticate.
    expect(authenticateLocal(await store.load(), 'op@example.org', 'a strong passphrase here').ok).toBe(false);
  });

  it('issues a one-time bootstrap token whose hash is verifiable', async () => {
    const store = new InMemoryOperatorStore();
    const token = await adminBootstrapToken(store, 3600);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyBootstrapToken(await store.load(), token)).toBe(true);
    expect(verifyBootstrapToken(await store.load(), 'wrong-token')).toBe(false);
  });
});
