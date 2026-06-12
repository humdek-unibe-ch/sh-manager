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
}

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
  return {
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
    SCHEDULED_JOBS_TICK_SECONDS: String(input.schedulerTickSeconds ?? 60),
    // JWT key *paths* are not secret (the keys themselves live in ./secrets/jwt,
    // mounted read-only at /app/config/jwt). The passphrase is in secrets.env.
    JWT_SECRET_KEY: '/app/config/jwt/private.pem',
    JWT_PUBLIC_KEY: '/app/config/jwt/public.pem',
    // Token lifetimes (seconds): access 1 hour, refresh 30 days. No config
    // default exists for either, so they must be provided here.
    JWT_TOKEN_TTL: '3600',
    JWT_REFRESH_TOKEN_TTL: '2592000',
    // Browser traffic reaches the API through the frontend BFF (same origin);
    // direct cross-origin browser access stays locked to localhost tooling.
    // Single-quoted so BOTH parsers (compose env_file + Symfony dotenv) take
    // the regex literally — unquoted, the trailing `$` would be eaten by
    // compose's `${…}` interpolation.
    CORS_ALLOW_ORIGIN: "'^https?://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?$'",
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
}

export function renderDotEnv(env: Record<string, string>): string {
  const header =
    '# Generated by SelfHelp Manager. Non-secret runtime config only.\n' +
    '# Secrets live in ./secrets/ with restrictive permissions.\n';
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return header + lines.join('\n') + '\n';
}
