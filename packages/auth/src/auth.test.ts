// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { authorizeOperator } from './authorize.js';
import { validateProviderConfig, type CampusProviderConfig } from './config.js';

const unibe: CampusProviderConfig = {
  enabled: true,
  displayName: 'UniBE Campus Account',
  issuer: 'https://login.example.unibe.ch/',
  clientId: 'selfhelp-manager',
  clientSecretFile: '/opt/selfhelp/manager/secrets/unibe_client_secret',
  redirectUri: 'https://selfhelp-manager.example.ch/auth/campus/unibe/callback',
  allowedEmailDomains: ['unibe.ch'],
  allowedEmails: ['admin@unibe.ch'],
  allowedGroups: ['selfhelp-manager-admins'],
  roleClaim: 'groups',
  roleMappings: [
    { match: { email: 'admin@unibe.ch' }, roles: ['server_owner'] },
    { match: { group: 'selfhelp-manager-admins' }, roles: ['instance_operator'] },
  ],
  scopes: ['openid', 'profile', 'email'],
};

describe('validateProviderConfig', () => {
  it('accepts a complete config', () => {
    expect(validateProviderConfig(unibe).ok).toBe(true);
  });
  it('requires a secret *file* and an allowlist', () => {
    const bad = validateProviderConfig({ ...unibe, clientSecretFile: '', allowedEmails: [], allowedEmailDomains: [], allowedGroups: [] });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/clientSecretFile/);
    expect(bad.errors.join(' ')).toMatch(/allowlist|allowed/i);
  });
});

describe('authorizeOperator', () => {
  it('maps an allowlisted admin email to server_owner', () => {
    const r = authorizeOperator({ email: 'admin@unibe.ch', groups: [] }, unibe);
    expect(r.authorized).toBe(true);
    expect(r.roles).toContain('server_owner');
  });

  it('maps an allowed group to instance_operator', () => {
    const r = authorizeOperator({ email: 'staff@unibe.ch', groups: ['selfhelp-manager-admins'] }, unibe);
    expect(r.authorized).toBe(true);
    expect(r.roles).toContain('instance_operator');
  });

  it('rejects a campus-authenticated user who is allowlisted by domain but has no role mapping', () => {
    const r = authorizeOperator({ email: 'random@unibe.ch', groups: [] }, unibe);
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/no manager role mapping/i);
  });

  it('rejects an identity outside every allowlist', () => {
    const r = authorizeOperator({ email: 'attacker@evil.com', groups: [] }, unibe);
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/allowlist/i);
  });

  it('rejects everything when the provider is disabled', () => {
    const r = authorizeOperator({ email: 'admin@unibe.ch' }, { ...unibe, enabled: false });
    expect(r.authorized).toBe(false);
  });

  it('honours an optional defaultRole for allowlisted users', () => {
    const r = authorizeOperator({ email: 'viewer@unibe.ch' }, { ...unibe, defaultRole: 'read_only' });
    expect(r.authorized).toBe(true);
    expect(r.roles).toEqual(['read_only']);
  });
});
