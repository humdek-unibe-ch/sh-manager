// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Redaction utilities for support bundles and review screens. Secrets must
 * never appear in bundles, logs, or operator-facing summaries.
 */
export const REDACTED = '***REDACTED***';

/** Object keys whose values are always redacted (case-insensitive substring). */
const SECRET_KEY_PATTERNS = [
  'secret',
  'password',
  'passwd',
  'token',
  'jwt',
  'private_key',
  'privatekey',
  'api_key',
  'apikey',
  'app_secret',
  'mercure',
  'client_secret',
  'session_secret',
  'bootstrap_token',
];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const DB_URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s@]+):([^@\s]+)@/gi;
const ENV_SECRET_LINE = /^(\s*[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|JWT|KEY)[A-Z0-9_]*\s*[:=]\s*)(.+)$/gim;

/** Redacts secrets from a free-text string (logs, env files, configs). */
export function redactString(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(DB_URL_CREDENTIALS, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`)
    .replace(ENV_SECRET_LINE, (_m, prefix: string) => `${prefix}${REDACTED}`);
}

/** Deep-redacts an object by key name and value content. */
export function redactObject<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redactObject(v);
    }
    return out as unknown as T;
  }
  return value;
}

export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = isSecretKey(k) ? REDACTED : redactString(v);
  }
  return out;
}

/** Detects residual secret-looking content (defense in depth for bundles). */
export function findResidualSecrets(text: string): string[] {
  const hits: string[] = [];
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) hits.push('PEM private key');
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:([^@\s]+)@/gi)) {
    if (m[1] !== REDACTED) {
      hits.push('DB URL with embedded credentials');
      break;
    }
  }
  return hits;
}
