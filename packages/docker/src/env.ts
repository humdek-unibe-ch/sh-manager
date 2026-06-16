// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Generated non-secret instance `.env` values.
 *
 * Enforces the must-not-break BFF URL invariant: browser traffic uses the
 * `/api` prefix, while server-side frontend code calls Symfony over the
 * internal Docker network. Operators never guess these values.
 */
import type { InstanceMode } from '@shm/schemas';

export const BACKEND_INTERNAL_PORT = 8080;
export const FRONTEND_INTERNAL_PORT = 3000;
export const DEFAULT_BROWSER_API_PREFIX = '/api';
export const DEFAULT_SYMFONY_API_PREFIX = '/cms-api/v1';
/**
 * Hub URL on the private instance network. The backend publishes here, and in
 * LOCAL mode subscribers (the frontend BFF's `/api/auth/events` proxy) connect
 * here too — a host URL like `http://localhost:<port>/...` is unreachable from
 * INSIDE the frontend container (its `localhost` is the container itself),
 * which made every events subscription die with a 503.
 */
export const INTERNAL_MERCURE_HUB_URL = 'http://mercure/.well-known/mercure';

export interface InstanceEnvInput {
  instanceId: string;
  mode: InstanceMode;
  selfhelpVersion: string;
  /**
   * Version of the deployed frontend image. The backend cannot know which
   * frontend build is running, so the manager injects it; the CMS surfaces it
   * on the admin system page (`SELFHELP_FRONTEND_VERSION`, else "unknown").
   */
  frontendVersion: string;
  publicFrontendUrl: string;
  browserApiPrefix?: string;
  symfonyApiPrefix?: string;
  schedulerTickSeconds?: number;
  /**
   * `SELFHELP_PLUGIN_TRUSTED_KEYS` value (`keyId=base64pubkey;…`) handed to
   * the backend so it can verify official plugin release signatures. Without
   * it the backend's verifier has NO trusted keys and silently filters every
   * signed registry plugin out of the CMS plugin catalogue.
   */
  pluginTrustedKeys?: string;
  /**
   * Registry the instance was installed from. Becomes the backend's default
   * plugin source (`SELFHELP_PLUGIN_DEFAULT_REGISTRY_URL`) so the CMS lists
   * plugins from the SAME registry the manager resolves releases against.
   */
  registryUrl?: string;
  /**
   * Operator-set non-secret env overrides (manager UI / CLI). Merged LAST so an
   * operator value wins over the generated default — EXCEPT for the structural
   * {@link MANAGER_CONTROLLED_ENV_KEYS}, which are always re-asserted so an
   * override can never brick instance identity, internal routing, JWT key
   * paths, or plugin-trust. Secrets never travel through here.
   */
  envOverrides?: Record<string, string>;
}

/**
 * Env keys the manager always owns: instance identity, internal Docker routing,
 * JWT key file paths, the public Mercure/edge URLs, plugin-trust + signature
 * enforcement, and the injected version stamps. Operators may NOT override these
 * from the environment editor — a wrong value here silently breaks networking,
 * auth, or the plugin catalogue. `MAILER_DSN` is included on purpose: a real
 * SMTP DSN can carry credentials, so it must go through the dedicated mailer
 * flow (stored in the restricted `secrets.env`), never the non-secret `.env`.
 */
export const MANAGER_CONTROLLED_ENV_KEYS: readonly string[] = [
  'SELFHELP_INSTANCE_ID',
  'SELFHELP_MODE',
  'SELFHELP_CMS_VERSION',
  'SELFHELP_FRONTEND_VERSION',
  'NEXT_PUBLIC_API_URL',
  'SYMFONY_INTERNAL_URL',
  'SYMFONY_API_PREFIX',
  'MERCURE_URL',
  'MERCURE_PUBLIC_URL',
  'JWT_SECRET_KEY',
  'JWT_PUBLIC_KEY',
  'MAILER_DSN',
  'SELFHELP_PLUGIN_TRUSTED_KEYS',
  'SELFHELP_PLUGIN_REQUIRE_SIGNATURE',
  'SELFHELP_PLUGIN_DEFAULT_REGISTRY_URL',
];

export interface InstanceRouting {
  publicFrontendUrl: string;
  browserApiPrefix: string;
  internalSymfonyUrl: string;
  symfonyApiPrefix: string;
}

export function buildInstanceRouting(input: InstanceEnvInput): InstanceRouting {
  return {
    publicFrontendUrl: input.publicFrontendUrl,
    browserApiPrefix: input.browserApiPrefix ?? DEFAULT_BROWSER_API_PREFIX,
    internalSymfonyUrl: `http://backend:${BACKEND_INTERNAL_PORT}`,
    symfonyApiPrefix: input.symfonyApiPrefix ?? DEFAULT_SYMFONY_API_PREFIX,
  };
}

/** Escapes a string so it can be embedded literally inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex alternative matching any loopback origin (localhost/127.0.0.1, any port). */
const LOCALHOST_ORIGIN_PATTERN = 'https?://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?';

/**
 * The browser Origins the backend accepts (used for CORS AND the backend's
 * Origin-based CSRF / cross-origin check).
 *
 * Localhost tooling is always allowed. A **production** instance must ALSO allow
 * its own public origin (`https://<domain>`): the admin UI and plugins issue
 * state-changing requests carrying the real site's `Origin`, and a backend that
 * only trusts localhost rejects them as a failed origin/CSRF check. That is the
 * "works on a local Docker instance, fails on the deployed domain" report — e.g.
 * SurveyJS **Create survey -> "CSRF validation failed"**. Local mode keeps the
 * strict localhost-only regex (its public origin already IS localhost).
 *
 * The value is single-quoted so neither compose's `${…}` interpolation nor
 * Symfony dotenv eats the trailing `$` anchor.
 */
function corsAllowOriginValue(input: InstanceEnvInput): string {
  const alternatives = [LOCALHOST_ORIGIN_PATTERN];
  if (input.mode === 'production') {
    let origin: string | null = null;
    try {
      origin = new URL(input.publicFrontendUrl).origin;
    } catch {
      origin = null;
    }
    // Add the public origin unless it is already a loopback form (covered above).
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
      alternatives.push(escapeRegExp(origin));
    }
  }
  const joined = alternatives.join('|');
  const body = alternatives.length > 1 ? `(${joined})` : joined;
  return `'^${body}$'`;
}

/**
 * Builds the non-secret env map. Secrets live in restricted secret files.
 *
 * This file is consumed twice with identical semantics:
 * - compose `env_file` injects every key as a real container env var;
 * - it is bind-mounted at `/app/.env`, the dotenv file Symfony's runtime
 *   REQUIRES to exist on every request/console boot (core images <= 0.1.2
 *   bake no default file, which fatally broke install provisioning).
 *
 * Because the mount shadows any `/app/.env` a newer image bakes, this map
 * must stay a SUPERSET of the backend image's secret-free defaults: every
 * backend env var with no `default:` fallback in its Symfony config has to be
 * present here (APP_DEBUG, JWT TTLs, CORS_ALLOW_ORIGIN, MAILER_DSN below),
 * or resolving it at runtime throws. Values mirror the backend's
 * `docker/.env.image-defaults`.
 */
export function buildInstanceEnv(input: InstanceEnvInput): Record<string, string> {
  const routing = buildInstanceRouting(input);
  const base: Record<string, string> = {
    APP_ENV: 'prod',
    APP_DEBUG: '0',
    SELFHELP_INSTANCE_ID: input.instanceId,
    SELFHELP_MODE: input.mode,
    // The env names the backend actually reads (config/services.yaml):
    // SELFHELP_CMS_VERSION feeds plugin-compatibility checks + the version
    // summary; SELFHELP_FRONTEND_VERSION feeds the admin system page (it
    // reports "unknown" when unset, e.g. source/dev checkouts).
    SELFHELP_CMS_VERSION: input.selfhelpVersion,
    SELFHELP_FRONTEND_VERSION: input.frontendVersion,
    // Browser path (BFF). Never the internal URL.
    NEXT_PUBLIC_API_URL: routing.browserApiPrefix,
    // Server-side frontend -> Symfony over the internal Docker network.
    SYMFONY_INTERNAL_URL: routing.internalSymfonyUrl,
    SYMFONY_API_PREFIX: routing.symfonyApiPrefix,
    // Internal hub URL the backend publishes to (plain HTTP on the private
    // instance network; the hub serves :80 via SERVER_NAME in the compose).
    // REQUIRED: the backend's Mercure hub service hard-fails to instantiate
    // when MERCURE_URL is unset (`new Hub(null)`), which 500s every request.
    MERCURE_URL: INTERNAL_MERCURE_HUB_URL,
    // Hub URL handed to SUBSCRIBERS by the backend's /auth/events bootstrap.
    // Production: the compose routes the hub at the edge under
    // https://<domain>/.well-known/mercure (works for the frontend BFF and
    // for mobile apps subscribing directly). Local: there is no edge and the
    // only subscriber is the BFF on the instance network, so hand out the
    // internal hub URL — never the host's localhost:<port>.
    MERCURE_PUBLIC_URL:
      input.mode === 'production'
        ? `${input.publicFrontendUrl}/.well-known/mercure`
        : INTERNAL_MERCURE_HUB_URL,
    // Public, user-facing frontend origin the backend stamps into the links it
    // emails (account validation, password reset, welcome…). Without it the
    // backend falls back to its dev default `http://localhost:3000`, so a real
    // instance mailed validation links to a port nobody is serving. Always the
    // instance's own public URL (host:port in local mode, https://<domain> in
    // production) — never the internal Docker URL.
    FRONTEND_BASE_URL: input.publicFrontendUrl,
    SCHEDULED_JOBS_TICK_SECONDS: String(input.schedulerTickSeconds ?? 60),
    // JWT key *paths* are not secret (the keys themselves live in ./secrets/jwt,
    // mounted read-only at /app/config/jwt). The passphrase is in secrets.env.
    JWT_SECRET_KEY: '/app/config/jwt/private.pem',
    JWT_PUBLIC_KEY: '/app/config/jwt/public.pem',
    // Token lifetimes (seconds): access 1 hour, refresh 30 days. No config
    // default exists for either, so they must be provided here.
    JWT_TOKEN_TTL: '3600',
    JWT_REFRESH_TOKEN_TTL: '2592000',
    // Browser traffic normally reaches the API through the frontend BFF (same
    // origin), but the backend ALSO validates the request Origin for CORS and
    // CSRF. Localhost tooling is always allowed; a production instance also
    // allows its own public origin so admin/plugin requests from the real domain
    // are not rejected as a failed origin/CSRF check (see corsAllowOriginValue).
    CORS_ALLOW_ORIGIN: corsAllowOriginValue(input),
    // Local mode ships a Mailpit container under this service name. An
    // operator-configured SMTP DSN may carry credentials, so it NEVER lands
    // here: it is written to secrets.env (0600), which compose loads after
    // this file and therefore overrides this default.
    MAILER_DSN: 'smtp://mailpit:1025',
    // Trusted plugin-signing keys + the registry the instance came from.
    // Public keys are not secret. Signature verification stays strict.
    ...(input.pluginTrustedKeys ? { SELFHELP_PLUGIN_TRUSTED_KEYS: input.pluginTrustedKeys } : {}),
    SELFHELP_PLUGIN_REQUIRE_SIGNATURE: 'true',
    ...(input.registryUrl ? { SELFHELP_PLUGIN_DEFAULT_REGISTRY_URL: input.registryUrl } : {}),
  };

  // Operator overrides win for everything EXCEPT the manager-owned structural
  // keys, which are re-asserted afterwards so a bad override can never brick the
  // instance. New (custom) keys an operator adds are kept as-is.
  if (input.envOverrides) {
    for (const [key, value] of Object.entries(input.envOverrides)) {
      if (MANAGER_CONTROLLED_ENV_KEYS.includes(key)) continue;
      base[key] = value;
    }
  }
  return base;
}

/**
 * Parses a `.env` text body into a key/value map. Only `KEY=VALUE` lines are
 * read; blank lines and `#` comments are ignored, and surrounding whitespace is
 * trimmed off the key. The value is taken verbatim (no quote stripping) so it
 * round-trips through {@link renderDotEnv} unchanged.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = rawLine.slice(rawLine.indexOf('=') + 1);
  }
  return out;
}

export function renderDotEnv(env: Record<string, string>): string {
  const header =
    '# Generated by SelfHelp Manager. Non-secret runtime config only.\n' +
    '# Secrets live in ./secrets/ with restrictive permissions.\n';
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return header + lines.join('\n') + '\n';
}
