// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildProxyCompose, PROXY_NETWORK, proxyComposeToYaml } from './index.js';

describe('buildProxyCompose', () => {
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
