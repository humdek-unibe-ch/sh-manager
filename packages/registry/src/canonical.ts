// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Canonical JSON serialisation + SHA-256 helpers.
 *
 * `canonicalize` MUST stay byte-identical with the registry's
 * `scripts/sign.mjs` `canonicalStringify` (and the host PHP
 * `SignedPayloadBuilder`) so a payload signed by CI verifies here:
 * object keys sorted, arrays order-preserved, strings/numbers via JSON.
 */
import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number not allowed.');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`Unsupported value: ${typeof value}`);
}

/** Lowercase hex SHA-256 of a UTF-8 string or byte buffer. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
    .digest('hex');
}

/** Normalises `sha256:<hex>` / `<hex>` to a bare lowercase hex digest. */
export function normalizeSha256(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, '');
}
