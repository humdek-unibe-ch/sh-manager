// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Bind + Host-header guards for the localhost-by-default manager UI.
 *
 * - {@link isLoopbackHost} gates the refusal to bind a non-loopback address
 *   unless the operator explicitly opts in.
 * - {@link hostHeaderIsLocal} is the DNS-rebinding defence applied to every
 *   request while the UI is loopback-only.
 * - {@link browseUrl} turns a bind address into a URL an operator can open.
 */
import type { IncomingMessage } from 'node:http';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * The URL an operator can actually open for a given bind. A wildcard bind
 * (`0.0.0.0` / `::` — the in-container case, reached through a published
 * loopback port) is browsable via localhost, never via the wildcard address.
 */
export function browseUrl(host: string, port: number): string {
  const wildcard = host === '0.0.0.0' || host === '::' || host === '';
  const display = wildcard ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${display}:${port}`;
}

export function hostHeaderIsLocal(req: IncomingMessage): boolean {
  const raw = req.headers.host;
  if (!raw) return true; // no Host header (HTTP/1.0 / direct socket) — allow on loopback bind
  const hostname = raw.split(':')[0] ?? '';
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost' || hostname === '[::1]';
}
