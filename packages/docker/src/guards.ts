// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Static safety guards over generated compose documents and compose commands.
 * These encode non-negotiable rules from the distribution plan.
 */
import { DEFAULT_PROXY_NETWORK, type ComposeDocument } from './compose.js';

const DOCKER_SOCKET = '/var/run/docker.sock';

export interface GuardViolation {
  rule: string;
  detail: string;
}

function servicesOf(doc: ComposeDocument): Record<string, Record<string, unknown>> {
  const services = doc.services;
  if (!services || typeof services !== 'object') return {};
  return services as Record<string, Record<string, unknown>>;
}

/** No runtime service may mount the Docker socket. */
export function findDockerSocketMounts(doc: ComposeDocument): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const [name, svc] of Object.entries(servicesOf(doc))) {
    const volumes = Array.isArray(svc.volumes) ? (svc.volumes as unknown[]) : [];
    for (const v of volumes) {
      if (typeof v === 'string' && v.includes(DOCKER_SOCKET)) {
        out.push({ rule: 'no-docker-socket', detail: `Service "${name}" mounts ${DOCKER_SOCKET}.` });
      } else if (v && typeof v === 'object' && (v as { source?: string }).source === DOCKER_SOCKET) {
        out.push({ rule: 'no-docker-socket', detail: `Service "${name}" mounts ${DOCKER_SOCKET}.` });
      }
    }
  }
  return out;
}

/**
 * Only edge-routed services may attach to the shared proxy network: the
 * frontend (the public app), the Mercure hub (subscriber SSE endpoint under
 * /.well-known/mercure in production), and the optional mobile-preview service
 * (Expo web export routed under /mobile-preview). DB/backend/worker/scheduler/
 * redis must never be reachable from the shared network — the mobile preview
 * reaches the backend over the PRIVATE instance network, so the backend keeps
 * no router of its own.
 */
const PROXY_ALLOWED_SERVICES = new Set(['frontend', 'mercure', 'mobile-preview']);

export function findProxyNetworkViolations(
  doc: ComposeDocument,
  proxyNetwork = DEFAULT_PROXY_NETWORK,
): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const [name, svc] of Object.entries(servicesOf(doc))) {
    const networks = svc.networks;
    const list = Array.isArray(networks)
      ? (networks as string[])
      : networks && typeof networks === 'object'
        ? Object.keys(networks)
        : [];
    if (list.includes(proxyNetwork) && !PROXY_ALLOWED_SERVICES.has(name)) {
      out.push({
        rule: 'only-edge-services-on-proxy',
        detail: `Service "${name}" must not be attached to the shared proxy network "${proxyNetwork}".`,
      });
    }
  }
  return out;
}

/** Aggregated compose safety check. Throws when any invariant is violated. */
export function assertComposeSafe(doc: ComposeDocument, proxyNetwork = DEFAULT_PROXY_NETWORK): void {
  const violations = [
    ...findDockerSocketMounts(doc),
    ...findProxyNetworkViolations(doc, proxyNetwork),
  ];
  if (violations.length > 0) {
    throw new Error(
      'Unsafe generated compose document:\n' + violations.map((v) => `- [${v.rule}] ${v.detail}`).join('\n'),
    );
  }
}

const DESTRUCTIVE_COMPOSE_FLAGS = ['-v', '--volumes', '--rmi'];

/**
 * Rejects destructive compose invocations. A normal update must never run
 * `docker compose down -v` or remove volumes; that would delete DB/uploads.
 */
export function assertSafeComposeArgs(args: string[]): void {
  if (args[0] === 'down') {
    const bad = args.filter((a) => DESTRUCTIVE_COMPOSE_FLAGS.includes(a));
    if (bad.length > 0) {
      throw new Error(
        `Refusing destructive "docker compose down ${bad.join(' ')}": ` +
          'persistent volumes (DB, uploads, plugin artifacts) must survive updates.',
      );
    }
  }
}
