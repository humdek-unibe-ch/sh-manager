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
        image: 'traefik:v3.1',
        restart: 'unless-stopped',
        command,
        ports,
        volumes,
        networks: [network],
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } },
      },
    },
    networks: { [network]: { name: network } },
  };
}

export function proxyComposeToYaml(opts: ProxyComposeOptions): string {
  return stringify(buildProxyCompose(opts), { lineWidth: 0 });
}
