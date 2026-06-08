// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, validatePasswordStrength, MIN_PASSWORD_LENGTH } from './password.js';

describe('password hashing', () => {
  it('hashes and verifies a strong password', () => {
    const digest = hashPassword('correct horse battery staple');
    expect(digest.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', digest)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const digest = hashPassword('correct horse battery staple');
    expect(verifyPassword('Tr0ub4dor&3-wrong', digest)).toBe(false);
  });

  it('never stores the raw password in the digest', () => {
    const secret = 'super-secret-operator-pw';
    const digest = hashPassword(secret);
    expect(digest).not.toContain(secret);
  });

  it('produces a different digest each time (random salt)', () => {
    const a = hashPassword('correct horse battery staple');
    const b = hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
    expect(verifyPassword('correct horse battery staple', a)).toBe(true);
    expect(verifyPassword('correct horse battery staple', b)).toBe(true);
  });

  it('refuses to hash a too-short password', () => {
    expect(() => hashPassword('short')).toThrow();
    expect(validatePasswordStrength('x'.repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
    expect(validatePasswordStrength('x'.repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
  });

  it('fails closed on a malformed digest', () => {
    expect(verifyPassword('whatever', 'not-a-real-digest')).toBe(false);
    expect(verifyPassword('whatever', 'scrypt$bad')).toBe(false);
  });
});
