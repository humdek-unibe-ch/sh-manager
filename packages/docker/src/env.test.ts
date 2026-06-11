// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildInstanceEnv, buildInstanceRouting, renderDotEnv } from './env.js';

const input = {
  instanceId: 'website1',
  mode: 'production' as const,
  selfhelpVersion: '1.5.0',
  frontendVersion: '1.4.2',
  publicFrontendUrl: 'https://website1.example.ch',
  mercurePublicUrl: 'https://website1.example.ch/.well-known/mercure',
};

describe('BFF URL invariant', () => {
  it('keeps browser traffic on /api and server-side on the internal URL', () => {
    const routing = buildInstanceRouting(input);
    expect(routing.browserApiPrefix).toBe('/api');
    expect(routing.internalSymfonyUrl).toMatch(/^http:\/\/backend:8080$/);
    expect(routing.symfonyApiPrefix).toBe('/cms-api/v1');
  });

  it('env never points the browser at the internal URL', () => {
    const env = buildInstanceEnv(input);
    expect(env.NEXT_PUBLIC_API_URL).toBe('/api');
    expect(env.SYMFONY_INTERNAL_URL).toBe('http://backend:8080');
    expect(env.NEXT_PUBLIC_API_URL).not.toContain('backend');
  });

  it('renders a .env without secrets', () => {
    const dotenv = renderDotEnv(buildInstanceEnv(input));
    expect(dotenv).toContain('SELFHELP_INSTANCE_ID=website1');
    expect(dotenv.toLowerCase()).not.toContain('password');
    expect(dotenv.toLowerCase()).not.toContain('secret=');
  });

  it('injects the version env names the backend reads', () => {
    // config/services.yaml reads SELFHELP_CMS_VERSION + SELFHELP_FRONTEND_VERSION;
    // without these the admin system page reports the baked default / "unknown".
    const env = buildInstanceEnv(input);
    expect(env.SELFHELP_CMS_VERSION).toBe('1.5.0');
    expect(env.SELFHELP_FRONTEND_VERSION).toBe('1.4.2');
    expect(env).not.toHaveProperty('SELFHELP_VERSION');
  });

  it('always sets the internal Mercure hub URL the backend publishes to', () => {
    // Regression: the backend's Mercure hub service hard-fails to instantiate
    // when MERCURE_URL is unset (`new Hub(null)` TypeError), which 500'd every
    // request and broke `app:create-admin-user` during provisioning.
    const env = buildInstanceEnv(input);
    expect(env.MERCURE_URL).toBe('http://mercure/.well-known/mercure');
    expect(env.MERCURE_PUBLIC_URL).toBe('https://website1.example.ch/.well-known/mercure');
  });
});
