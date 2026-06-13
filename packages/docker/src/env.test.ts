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

  it('hands LOCAL-mode subscribers the internal hub URL, never the host port', () => {
    // Regression: MERCURE_PUBLIC_URL=http://localhost:<port>/... is the HOST's
    // address — from inside the frontend container `localhost` is the
    // container itself, so the BFF's /api/auth/events hub fetch failed with
    // 503 on every manager-installed local instance.
    const env = buildInstanceEnv({
      ...input,
      mode: 'local',
      publicFrontendUrl: 'http://localhost:9123',
    });
    expect(env.MERCURE_PUBLIC_URL).toBe('http://mercure/.well-known/mercure');
    expect(env.MERCURE_PUBLIC_URL).not.toContain('localhost');
  });

  it('is a superset of the backend image dotenv defaults (mounted at /app/.env)', () => {
    // The instance .env is bind-mounted as the Symfony dotenv file, shadowing
    // any /app/.env a newer image bakes — so every backend env var WITHOUT a
    // `default:` fallback in its Symfony config must be present here, or
    // resolving it throws at runtime (and on cores <= 0.1.2 the whole console
    // fatals because no dotenv file exists at all).
    const env = buildInstanceEnv(input);
    expect(env.APP_ENV).toBe('prod');
    expect(env.APP_DEBUG).toBe('0');
    expect(env.JWT_SECRET_KEY).toBe('/app/config/jwt/private.pem');
    expect(env.JWT_PUBLIC_KEY).toBe('/app/config/jwt/public.pem');
    expect(env.JWT_TOKEN_TTL).toBe('3600');
    expect(env.JWT_REFRESH_TOKEN_TTL).toBe('2592000');
    expect(env.MAILER_DSN).toBe('smtp://mailpit:1025');
    expect(env.CORS_ALLOW_ORIGIN).toBeTruthy();
  });

  it('keeps the CORS regex single-quoted so compose interpolation cannot eat the `$` anchor', () => {
    const dotenv = renderDotEnv(buildInstanceEnv(input));
    expect(dotenv).toContain("CORS_ALLOW_ORIGIN='^https?://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?$'");
  });
});

describe('plugin trust env (verification chain, security)', () => {
  const trusted = 'shm-release-1=BASE64PUBKEYAAAA;shm-release-2=BASE64PUBKEYBBBB';
  const registry = 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/';

  it('hands the backend exactly the trusted plugin-signing keys and the install registry', () => {
    const env = buildInstanceEnv({ ...input, pluginTrustedKeys: trusted, registryUrl: registry });
    // Exactly the manager's active trusted keys — never more, never rewritten.
    expect(env.SELFHELP_PLUGIN_TRUSTED_KEYS).toBe(trusted);
    // The CMS lists plugins from the SAME registry the manager installs from.
    expect(env.SELFHELP_PLUGIN_DEFAULT_REGISTRY_URL).toBe(registry);
  });

  it('always requires plugin signatures — strictness is hardcoded, not configurable', () => {
    // With and without keys, the generated env NEVER weakens verification.
    expect(buildInstanceEnv(input).SELFHELP_PLUGIN_REQUIRE_SIGNATURE).toBe('true');
    expect(
      buildInstanceEnv({ ...input, pluginTrustedKeys: trusted, registryUrl: registry })
        .SELFHELP_PLUGIN_REQUIRE_SIGNATURE,
    ).toBe('true');
  });

  it('failure path: no trusted keys -> no key var at all (backend trusts NOTHING, not anything)', () => {
    // An empty SELFHELP_PLUGIN_TRUSTED_KEYS= line must never be emitted: with
    // signatures required and no keys, the backend's verifier rejects every
    // plugin — fail closed. The variable is simply absent.
    const env = buildInstanceEnv(input);
    expect(env).not.toHaveProperty('SELFHELP_PLUGIN_TRUSTED_KEYS');
    const dotenv = renderDotEnv(env);
    expect(dotenv).not.toContain('SELFHELP_PLUGIN_TRUSTED_KEYS');
    expect(dotenv).toContain('SELFHELP_PLUGIN_REQUIRE_SIGNATURE=true');
  });
});
