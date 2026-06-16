// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  MANAGER_CONTROLLED_ENV_KEYS,
  buildInstanceEnv,
  buildInstanceRouting,
  parseDotEnv,
  renderDotEnv,
} from './env.js';

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

  it('stamps the public frontend URL the backend uses for emailed links', () => {
    // Regression: validation / password-reset emails linked to the backend's
    // dev default http://localhost:3000 because FRONTEND_BASE_URL was never
    // emitted — they must point at the instance's own public URL.
    expect(buildInstanceEnv(input).FRONTEND_BASE_URL).toBe('https://website1.example.ch');
    expect(
      buildInstanceEnv({ ...input, mode: 'local', publicFrontendUrl: 'http://localhost:9123' })
        .FRONTEND_BASE_URL,
    ).toBe('http://localhost:9123');
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

  it('allows the public origin (plus localhost) for the backend CORS/CSRF origin check in production', () => {
    // Regression: a production instance whose backend trusted ONLY localhost
    // rejected every state-changing admin/plugin request coming from the real
    // domain as a failed origin/CSRF check — the "works on a local Docker
    // instance, fails on the deployed domain" report (e.g. SurveyJS
    // "Create survey" -> "CSRF validation failed"). The public https origin must
    // be allowed too. Still single-quoted so compose/dotenv cannot eat the `$`.
    const dotenv = renderDotEnv(buildInstanceEnv(input));
    expect(dotenv).toContain(
      "CORS_ALLOW_ORIGIN='^(https?://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?|https://website1\\.example\\.ch)$'",
    );
  });

  it('keeps the strict localhost-only CORS regex for local mode (its origin already IS localhost)', () => {
    const dotenv = renderDotEnv(
      buildInstanceEnv({ ...input, mode: 'local', publicFrontendUrl: 'http://localhost:9123' }),
    );
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

describe('operator env overrides (manager environment editor)', () => {
  it('lets an operator override an editable default and add a custom var', () => {
    const env = buildInstanceEnv({
      ...input,
      envOverrides: { JWT_TOKEN_TTL: '7200', MY_FEATURE_FLAG: 'on' },
    });
    expect(env.JWT_TOKEN_TTL).toBe('7200'); // overrode the 3600 default
    expect(env.MY_FEATURE_FLAG).toBe('on'); // brand-new custom key
  });

  it('NEVER lets an override clobber a manager-controlled structural key', () => {
    // Identity, internal routing, JWT key paths, plugin trust, and the mailer
    // DSN are re-asserted after overrides so a bad value cannot brick the
    // instance or smuggle SMTP credentials into the non-secret .env.
    const env = buildInstanceEnv({
      ...input,
      pluginTrustedKeys: 'k=AAAA',
      envOverrides: {
        SELFHELP_INSTANCE_ID: 'evil',
        SYMFONY_INTERNAL_URL: 'http://attacker',
        SELFHELP_PLUGIN_REQUIRE_SIGNATURE: 'false',
        MAILER_DSN: 'smtp://user:pass@evil.example',
        JWT_SECRET_KEY: '/tmp/evil.pem',
      },
    });
    expect(env.SELFHELP_INSTANCE_ID).toBe('website1');
    expect(env.SYMFONY_INTERNAL_URL).toBe('http://backend:8080');
    expect(env.SELFHELP_PLUGIN_REQUIRE_SIGNATURE).toBe('true');
    expect(env.MAILER_DSN).toBe('smtp://mailpit:1025');
    expect(env.JWT_SECRET_KEY).toBe('/app/config/jwt/private.pem');
  });

  it('every manager-controlled key is genuinely protected from overrides', () => {
    const tampered = Object.fromEntries(MANAGER_CONTROLLED_ENV_KEYS.map((k) => [k, 'TAMPERED']));
    const base = buildInstanceEnv({ ...input, pluginTrustedKeys: 'k=AAAA', registryUrl: 'https://r/' });
    const withOverrides = buildInstanceEnv({
      ...input,
      pluginTrustedKeys: 'k=AAAA',
      registryUrl: 'https://r/',
      envOverrides: tampered,
    });
    for (const key of MANAGER_CONTROLLED_ENV_KEYS) {
      expect(withOverrides[key]).toBe(base[key]);
    }
  });
});

describe('parseDotEnv', () => {
  it('round-trips renderDotEnv output (ignoring comments/blank lines)', () => {
    const env = buildInstanceEnv({ ...input, envOverrides: { MY_VAR: 'hello world' } });
    const parsed = parseDotEnv(renderDotEnv(env));
    expect(parsed).toMatchObject(env);
    expect(parsed.MY_VAR).toBe('hello world');
  });

  it('keeps values verbatim (including = and quotes) and skips junk lines', () => {
    const parsed = parseDotEnv(
      ['# a comment', '', '  KEY_A = value-a ', 'DSN=smtp://u:p@h:587/?x=1', 'not a kv line', '123BAD=x'].join('\n'),
    );
    expect(parsed.KEY_A).toBe(' value-a '); // value verbatim; key trimmed
    expect(parsed.DSN).toBe('smtp://u:p@h:587/?x=1'); // first `=` splits only
    expect(parsed).not.toHaveProperty('123BAD'); // invalid identifier ignored
  });
});
