// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Pure presentation helpers. No DOM, no network — easy to unit test.
 */
import type { WizardConfig } from './types';

/** Turn a display name into a safe instance id suggestion. */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // Instance ids must start with a letter and end alphanumeric (server rule).
  const trimmed = base.replace(/^[^a-z]+/, '').replace(/-+$/g, '');
  return trimmed;
}

/** Build the public URL the operator will visit, from the collected config. */
export function publicUrlPreview(config: Pick<WizardConfig, 'mode' | 'domain' | 'localPort'>): string {
  if (config.mode === 'production') {
    return config.domain ? `https://${config.domain}` : 'https://your-domain.example';
  }
  const port = config.localPort ?? 8080;
  return `http://localhost:${port}`;
}

/** Filesystem path for an instance under the install root. */
export function instanceDir(root: string, instanceId: string): string {
  const cleanRoot = root.replace(/\/+$/, '') || '/opt/selfhelp';
  return `${cleanRoot}/instances/${instanceId || 'instance'}`;
}

/** Split a joined preflight summary into individual human lines. */
export function splitDetail(detail: string | undefined): string[] {
  if (!detail) return [];
  return detail
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const SECRET_HINTS = ['password', 'secret', 'token', 'private key', 'apikey', 'api key'];

/**
 * Defensive guard: never surface a string that looks like it carries a secret.
 * The installer generates and stores secrets server-side; the UI must not echo
 * them even if a detail string accidentally contained one.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const hint of SECRET_HINTS) {
    const re = new RegExp(`(${hint}\\s*[:=]\\s*)(\\S+)`, 'gi');
    out = out.replace(re, '$1••••••');
  }
  return out;
}

export function titleCase(input: string): string {
  return input.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
