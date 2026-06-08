// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Local operator password hashing for the SelfHelp Manager.
 *
 * Uses Node's built-in scrypt (no third-party crypto dependency). Raw
 * passwords are NEVER stored: only a self-describing, salted scrypt digest of
 * the form `scrypt$N$r$p$keylen$<salt-b64>$<hash-b64>`. Verification is
 * constant-time. The same string is safe to persist in the operator store on
 * disk (it is a one-way digest, not a secret that can be reversed).
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt cost parameters. N must be a power of two. */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Minimum acceptable local-operator password length. */
export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordStrength {
  ok: boolean;
  reason?: string;
}

/**
 * A deliberately small strength policy: length only. The manager is operated
 * by a handful of trusted server operators, not the public; length is the
 * dominant factor and avoids brittle composition rules.
 */
export function validatePasswordStrength(password: string): PasswordStrength {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  return { ok: true };
}

/**
 * Hash a password. The scrypt `maxmem` is raised to fit the default N so
 * hashing does not throw on the standard cost parameters.
 */
export function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): string {
  const strength = validatePasswordStrength(password);
  if (!strength.ok) {
    throw new Error(strength.reason ?? 'Weak password.');
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r,
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    params.keylen,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against a stored digest in constant time. Returns false
 * for any malformed digest rather than throwing, so a corrupt store entry can
 * never authenticate.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const keylen = Number(parts[4]);
  const saltB64 = parts[5];
  const hashB64 = parts[6];
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || !Number.isInteger(keylen)) {
    return false;
  }
  if (saltB64 === undefined || hashB64 === undefined) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== keylen) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, keylen, { N, r, p, maxmem: 256 * N * r });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
