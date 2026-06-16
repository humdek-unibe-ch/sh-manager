// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared SelfHelp-managed Traefik reverse proxy. Exactly one proxy per server;
 * it is the only shared runtime component between instances.
 *
 * Traefik mounts the Docker socket read-only to discover instance routing
 * labels. This is the proxy infrastructure container, not a SelfHelp instance
 * runtime container, so the "no docker socket in runtime containers" rule
 * (enforced on instance compose docs) does not apply here.
 */
import { stringify } from 'yaml';

export const PROXY_NETWORK = 'selfhelp_proxy';

/**
 * Pinned Traefik image for the shared proxy.
 *
 * MUST stay >= v3.6.1: Docker Engine 29 raised the daemon's MINIMUM API version
 * to 1.44, and Traefik < 3.6.1 hardcoded Docker API 1.24 in its Docker provider.
 * On Engine 29+ that provider then fails every poll with "client version 1.24 is
 * too old. Minimum supported API version is 1.44" and discovers NO containers —
 * so Traefik has zero routers and answers every request with a 404, even though
 * the instances are healthy and correctly labelled. v3.6.1 added Docker API
 * version auto-negotiation (traefik/traefik#12256); we pin a current v3.7 patch.
 * The DOCKER_API_VERSION env var does NOT help — Traefik ignores it (#12420).
 */
export const TRAEFIK_IMAGE = 'traefik:v3.7.5';

export interface ProxyComposeOptions {
  mode: 'production' | 'local';
  network?: string;
  letsencryptEmail?: string;
  /**
   * ENGINE-visible absolute path of the proxy directory. Set when the manager
   * container sees the state root at a different path than the Docker engine
   * (Docker Desktop, non-default mounts) so the Let's Encrypt bind source is
   * emitted absolute for the engine. Unset keeps the relative `./letsencrypt`.
   */
  hostBindDir?: string;
}

export function buildProxyCompose(opts: ProxyComposeOptions): Record<string, unknown> {
  const network = opts.network ?? PROXY_NETWORK;
  const command: string[] = [
    '--providers.docker=true',
    '--providers.docker.exposedbydefault=false',
    `--providers.docker.network=${network}`,
    '--entrypoints.web.address=:80',
    '--entrypoints.websecure.address=:443',
  ];
  const ports = ['80:80', '443:443'];
  const volumes = ['/var/run/docker.sock:/var/run/docker.sock:ro'];

  if (opts.mode === 'production') {
    if (!opts.letsencryptEmail) {
      throw new Error('Production proxy requires a Let\'s Encrypt contact email.');
    }
    command.push(
      '--certificatesresolvers.letsencrypt.acme.tlschallenge=true',
      `--certificatesresolvers.letsencrypt.acme.email=${opts.letsencryptEmail}`,
      '--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json',
      '--entrypoints.web.http.redirections.entrypoint.to=websecure',
      '--entrypoints.web.http.redirections.entrypoint.scheme=https',
    );
    const letsencryptHostDir = opts.hostBindDir ? `${opts.hostBindDir}/letsencrypt` : './letsencrypt';
    volumes.push(`${letsencryptHostDir}:/letsencrypt`);
  }

  return {
    name: 'selfhelp_proxy',
    services: {
      traefik: {
        image: TRAEFIK_IMAGE,
        restart: 'unless-stopped',
        command,
        ports,
        volumes,
        networks: [network],
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } },
      },
    },
    // The shared proxy network is manager-owned (created idempotently by
    // `ensureNetwork` during server init, so it also exists in local mode where
    // no proxy container runs) and referenced as `external` by every instance
    // compose. The proxy compose must declare it `external` too: otherwise
    // `docker compose up -d` tries to *own* a network it did not create and
    // aborts with "network selfhelp_proxy was found but has incorrect label
    // com.docker.compose.network set to "" (expected: ...)".
    networks: { [network]: { external: true, name: network } },
  };
}

export function proxyComposeToYaml(opts: ProxyComposeOptions): string {
  return stringify(buildProxyCompose(opts), { lineWidth: 0 });
}
