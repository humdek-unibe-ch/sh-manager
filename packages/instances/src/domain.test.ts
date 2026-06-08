// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  evaluateDnsBinding,
  isValidPublicHostname,
  validateDomainForInstall,
} from './domain.js';

describe('isValidPublicHostname', () => {
  it('accepts normal public domains', () => {
    expect(isValidPublicHostname('cms.example.org')).toBe(true);
    expect(isValidPublicHostname('a-b.c.example.com')).toBe(true);
  });

  it('rejects localhost, ports, paths, and single labels', () => {
    expect(isValidPublicHostname('localhost')).toBe(false);
    expect(isValidPublicHostname('example.com:8080')).toBe(false);
    expect(isValidPublicHostname('example.com/path')).toBe(false);
    expect(isValidPublicHostname('singlelabel')).toBe(false);
    expect(isValidPublicHostname('-bad.example.com')).toBe(false);
    expect(isValidPublicHostname('')).toBe(false);
  });
});

describe('evaluateDnsBinding', () => {
  it('flags domains with no records', () => {
    expect(evaluateDnsBinding({ a: [], aaaa: [] }).status).toBe('no-records');
  });

  it('flags a mismatch against the known server IP', () => {
    const b = evaluateDnsBinding({ a: ['203.0.113.9'], aaaa: [] }, '198.51.100.5');
    expect(b.status).toBe('mismatch');
    expect(b.detail).toContain('203.0.113.9');
  });

  it('matches when records include the server IP', () => {
    expect(evaluateDnsBinding({ a: ['198.51.100.5'], aaaa: [] }, '198.51.100.5').status).toBe('match');
  });

  it('treats any records as a match when the server IP is unknown', () => {
    expect(evaluateDnsBinding({ a: ['203.0.113.9'], aaaa: [] }).status).toBe('match');
  });
});

describe('validateDomainForInstall', () => {
  it('local mode only needs a port, never DNS', () => {
    expect(validateDomainForInstall({ mode: 'local', localPort: 8080, existingDomains: ['cms.example.org'] })).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
    expect(validateDomainForInstall({ mode: 'local', existingDomains: [] }).ok).toBe(false);
  });

  it('production requires a valid, unique domain', () => {
    expect(validateDomainForInstall({ mode: 'production', existingDomains: [] }).errors[0]).toMatch(/requires a domain/);
    expect(validateDomainForInstall({ mode: 'production', domain: 'not a domain', existingDomains: [] }).ok).toBe(false);
    expect(validateDomainForInstall({ mode: 'production', domain: 'cms.example.org', existingDomains: [] }).ok).toBe(true);
  });

  it('rejects a duplicate domain already in the inventory (case-insensitive)', () => {
    const res = validateDomainForInstall({
      mode: 'production',
      domain: 'CMS.Example.ORG',
      existingDomains: ['cms.example.org'],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/already used by another instance/);
  });

  it('ignores the instance own domain when re-validating', () => {
    const res = validateDomainForInstall({
      mode: 'production',
      domain: 'cms.example.org',
      existingDomains: ['cms.example.org'],
      excludeInstanceDomain: 'cms.example.org',
    });
    expect(res.ok).toBe(true);
  });

  it('warns on DNS problems by default and blocks under strictDns', () => {
    const warn = validateDomainForInstall({
      mode: 'production',
      domain: 'cms.example.org',
      existingDomains: [],
      dns: { a: ['203.0.113.9'], aaaa: [] },
      serverPublicIp: '198.51.100.5',
    });
    expect(warn.ok).toBe(true);
    expect(warn.warnings.join(' ')).toMatch(/DNS check/);

    const block = validateDomainForInstall({
      mode: 'production',
      domain: 'cms.example.org',
      existingDomains: [],
      dns: { a: ['203.0.113.9'], aaaa: [] },
      serverPublicIp: '198.51.100.5',
      strictDns: true,
    });
    expect(block.ok).toBe(false);
    expect(block.errors.join(' ')).toMatch(/DNS check/);
  });
});
