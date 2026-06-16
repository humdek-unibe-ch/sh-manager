// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildProxyCompose, PROXY_NETWORK, TRAEFIK_IMAGE, proxyComposeToYaml } from './index.js';

describe('buildProxyCompose', () => {
  it('pins a Traefik image new enough to negotiate the Docker API (Engine 29+ needs >= v3.6.1)', () => {
    // Regression: Docker Engine 29 enforces a MINIMUM Docker API version of 1.44.
    // Traefik < 3.6.1 hardcoded API 1.24, so its Docker provider failed on Engine
    // 29+ ("client version 1.24 is too old"), discovered no containers, and 404'd
    // every request. v3.6.1 added API auto-negotiation. Guard the floor so a
    // future edit cannot regress the pin below it.
    const doc = buildProxyCompose({ mode: 'local' });
    const image = (doc.services as { traefik: { image: string } }).traefik.image;
    expect(image).toBe(TRAEFIK_IMAGE);
    const m = /^traefik:v(\d+)\.(\d+)\.(\d+)$/.exec(image);
    expect(m).not.toBeNull();
    const [major, minor, patch] = [Number(m![1]), Number(m![2]), Number(m![3])];
    const atLeast361 = major > 3 || (major === 3 && (minor > 6 || (minor === 6 && patch >= 1)));
    expect(atLeast361).toBe(true);
  });

  it('configures Let\'s Encrypt + HTTPS redirect in production', () => {
    const doc = buildProxyCompose({ mode: 'production', letsencryptEmail: 'ops@example.ch' });
    const cmd = (doc.services as { traefik: { command: string[] } }).traefik.command.join(' ');
    expect(cmd).toContain('certificatesresolvers.letsencrypt');
    expect(cmd).toContain('redirections.entrypoint.scheme=https');
    expect((doc.networks as Record<string, unknown>)[PROXY_NETWORK]).toBeDefined();
  });

  it('requires a contact email in production', () => {
    expect(() => buildProxyCompose({ mode: 'production' })).toThrow(/email/i);
  });

  it('omits Let\'s Encrypt in local mode and mounts the socket read-only', () => {
    const doc = buildProxyCompose({ mode: 'local' });
    const traefik = (doc.services as { traefik: { command: string[]; volumes: string[] } }).traefik;
    expect(traefik.command.join(' ')).not.toContain('letsencrypt');
    expect(traefik.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock:ro');
  });

  it('renders YAML', () => {
    expect(proxyComposeToYaml({ mode: 'local' })).toContain('traefik');
  });

  it('declares the shared proxy network as external so compose reuses the manager-created one', () => {
    // Regression: server init creates `selfhelp_proxy` via `docker network
    // create` (so it exists in local mode too) and then runs `docker compose
    // up -d` for the proxy. A non-external network declaration made compose try
    // to OWN that pre-existing network and abort with "network selfhelp_proxy
    // was found but has incorrect label com.docker.compose.network set to ...".
    for (const mode of ['production', 'local'] as const) {
      const doc = buildProxyCompose(
        mode === 'production' ? { mode, letsencryptEmail: 'ops@example.ch' } : { mode },
      );
      const net = (doc.networks as Record<string, { external?: boolean; name?: string }>)[PROXY_NETWORK];
      expect(net).toEqual({ external: true, name: PROXY_NETWORK });
    }
    expect(proxyComposeToYaml({ mode: 'local' })).toContain('external: true');
  });

  it('emits the Let\'s Encrypt bind absolute for the engine when hostBindDir is set', () => {
    const doc = buildProxyCompose({
      mode: 'production',
      letsencryptEmail: 'ops@example.ch',
      hostBindDir: '/run/desktop/mnt/host/d/selfhelp/proxy',
    });
    const traefik = (doc.services as { traefik: { volumes: string[] } }).traefik;
    expect(traefik.volumes).toContain('/run/desktop/mnt/host/d/selfhelp/proxy/letsencrypt:/letsencrypt');
    expect(traefik.volumes).not.toContain('./letsencrypt:/letsencrypt');
  });

  it('keeps the relative Let\'s Encrypt bind without hostBindDir (same-path mounts)', () => {
    const doc = buildProxyCompose({ mode: 'production', letsencryptEmail: 'ops@example.ch' });
    expect((doc.services as { traefik: { volumes: string[] } }).traefik.volumes).toContain('./letsencrypt:/letsencrypt');
  });
});
