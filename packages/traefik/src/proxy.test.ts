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
});
