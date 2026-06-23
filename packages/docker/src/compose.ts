// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Per-instance Docker Compose generation.
 *
 * Hard invariants enforced here (see the distribution plan):
 * - every instance gets its own networks/volumes and unique compose project;
 * - only edge-routed services (frontend, and in production the Mercure hub
 *   under /.well-known/mercure) attach to the shared proxy network;
 * - backend/worker/scheduler/db/redis stay on the private network;
 * - every long-running service has log rotation configured;
 * - no runtime service mounts the Docker socket;
 * - MySQL data lives in a per-instance persistent volume.
 */
import { stringify } from 'yaml';
import type { InstanceImages, InstanceMode, InstanceResourceConfig } from '@shm/schemas';

export const DEFAULT_PROXY_NETWORK = 'selfhelp_proxy';
export const DEFAULT_SCHEDULER_TICK_SECONDS = 60;
const DEFAULT_LOG_MAX_SIZE_MB = 10;
const DEFAULT_LOG_MAX_FILES = 5;

/**
 * Optional `selfhelp-mobile-preview` service wiring. The Node static+proxy
 * server (`web-preview/server.mjs`) listens on this port, serves the Expo web
 * export under {@link MOBILE_PREVIEW_BASE_PATH}, and reverse-proxies a narrow
 * allowlist of `/cms-api` calls to the PRIVATE backend over the instance
 * network — so the backend never gets a Traefik router of its own.
 */
const MOBILE_PREVIEW_INTERNAL_PORT = 8080;
const MOBILE_PREVIEW_BASE_PATH = '/mobile-preview';
const BACKEND_INTERNAL_PORT = 8080;

/**
 * Secret wiring conventions (kept in sync with `@shm/instances` secrets module).
 * Compose never inlines a secret value: it loads them from a `0600` env file and
 * mounts the JWT keypair read-only.
 */
const SECRETS_ENV_FILE = 'secrets/secrets.env';
const JWT_KEYS_HOST_DIR = './secrets/jwt';
const JWT_KEYS_CONTAINER_DIR = '/app/config/jwt';
const NON_SECRET_ENV = ['.env'];
const SECRET_AWARE_ENV = ['.env', SECRETS_ENV_FILE];
/**
 * The instance's non-secret `.env` is ALSO bind-mounted into the Symfony
 * services as `/app/.env`: Symfony's runtime boots a dotenv file on every
 * request/console command and FATALS when none exists ("Unable to read the
 * /app/.env environment file"), which broke install provisioning at `wait_db`
 * on every published core image that does not bake a default `/app/.env`
 * (core <= 0.1.2). Compose's `env_file` only injects process env vars — it
 * never creates the file — so the manager guarantees the file itself. Real
 * container env vars always override dotenv values, so the mount is inert on
 * images that already bake their own defaults file.
 */
const ENV_HOST_FILE = './.env';
const ENV_CONTAINER_FILE = '/app/.env';

/**
 * Persistent application data the Symfony services (backend/worker/scheduler)
 * read and write. These MUST be named volumes so user uploads and installed
 * plugin artifacts survive container replacement during updates, and so backups
 * archive real data instead of an empty volume.
 *
 * The backend writes uploads under `public/uploads` (admin assets +
 * form-file uploads) and plugin artifacts to two distinct container paths:
 * `var/plugins` (installed packages) and `public/plugin-artifacts`
 * (web-served ESM/CSS bundles). See backend `AdminAssetService`,
 * `FormFileUploadService`, and `PluginArchivePromoter`.
 */
const UPLOADS_VOLUME = 'uploads';
const UPLOADS_CONTAINER_DIR = '/app/public/uploads';
const PLUGIN_ARTIFACTS_VOLUME = 'plugin_artifacts';
const PLUGIN_ARTIFACTS_CONTAINER_DIR = '/app/var/plugins';
const PLUGIN_ARTIFACTS_PUBLIC_VOLUME = 'plugin_artifacts_public';
const PLUGIN_ARTIFACTS_PUBLIC_CONTAINER_DIR = '/app/public/plugin-artifacts';
/**
 * The uid/gid PHP runs as inside the published core images (www-data on the
 * Debian-based FrankenPHP image). The named volumes above are created
 * root-owned by the engine on first mount (the images do not pre-bake the
 * mount paths), so without an ownership hand-off the very first plugin
 * install or file upload dies with `mkdir(): Permission denied`.
 */
const APP_RUNTIME_UID = 33;
const VOLUME_INIT_SERVICE = 'volume-init';

export interface InstanceComposeSpec {
  instanceId: string;
  mode: InstanceMode;
  images: InstanceImages;
  /** Production: routed domain. */
  domain?: string;
  /** Local: published localhost port. */
  localPort?: number;
  proxyNetwork?: string;
  resources?: InstanceResourceConfig;
  schedulerTickSeconds?: number;
  /** Local mode default: include a Mailpit container (no real outbound mail). */
  includeMailpit?: boolean;
  /**
   * ENGINE-visible absolute path of this instance's directory. Bind-mount
   * sources are interpreted by the Docker engine, so when the manager container
   * sees the state root at a different path than the engine does (Docker
   * Desktop, non-default mounts), they must be emitted absolute from the
   * engine's point of view. Unset (same-path mounts, the documented Linux
   * production layout) keeps the relative `./…` sources.
   */
  hostBindDir?: string;
}

export type ComposeDocument = Record<string, unknown>;

export function composeProjectName(instanceId: string): string {
  return `selfhelp_${instanceId}`;
}

function loggingBlock(resources?: InstanceResourceConfig): Record<string, unknown> {
  return {
    driver: 'json-file',
    options: {
      'max-size': `${resources?.logMaxSizeMb ?? DEFAULT_LOG_MAX_SIZE_MB}m`,
      'max-file': String(resources?.logMaxFiles ?? DEFAULT_LOG_MAX_FILES),
    },
  };
}

function deployLimits(resources?: InstanceResourceConfig): Record<string, unknown> | undefined {
  if (!resources || (resources.memoryLimitMb === undefined && resources.cpuLimit === undefined)) {
    return undefined;
  }
  const limits: Record<string, unknown> = {};
  if (resources.memoryLimitMb !== undefined) limits.memory = `${resources.memoryLimitMb}M`;
  if (resources.cpuLimit !== undefined) limits.cpus = String(resources.cpuLimit);
  return { resources: { limits } };
}

function baseService(
  image: string,
  networks: string[],
  resources?: InstanceResourceConfig,
  envFiles: string[] = NON_SECRET_ENV,
): Record<string, unknown> {
  const svc: Record<string, unknown> = {
    image,
    restart: 'unless-stopped',
    env_file: [...envFiles],
    networks,
    logging: loggingBlock(resources),
  };
  const deploy = deployLimits(resources);
  if (deploy) svc.deploy = deploy;
  return svc;
}

/** Builds the compose document object for one instance. */
export function buildInstanceCompose(spec: InstanceComposeSpec): ComposeDocument {
  const proxyNetwork = spec.proxyNetwork ?? DEFAULT_PROXY_NETWORK;
  const tick = spec.schedulerTickSeconds ?? DEFAULT_SCHEDULER_TICK_SECONDS;
  const id = spec.instanceId;
  const includeMailpit = spec.includeMailpit ?? spec.mode === 'local';

  // Only the frontend touches the shared proxy network.
  const frontend = baseService(spec.images.frontend, ['instance', proxyNetwork], spec.resources);
  if (spec.mode === 'production') {
    const domain = spec.domain;
    if (!domain) throw new Error('Production compose requires a domain.');
    frontend.labels = [
      'traefik.enable=true',
      `traefik.docker.network=${proxyNetwork}`,
      `traefik.http.routers.${id}.rule=Host(\`${domain}\`)`,
      `traefik.http.routers.${id}.entrypoints=websecure`,
      `traefik.http.routers.${id}.tls=true`,
      `traefik.http.routers.${id}.tls.certresolver=letsencrypt`,
      `traefik.http.services.${id}.loadbalancer.server.port=3000`,
    ];
  } else {
    const port = spec.localPort;
    if (port === undefined) throw new Error('Local compose requires a localPort.');
    frontend.ports = [`127.0.0.1:${port}:3000`];
  }

  // Backend/worker/scheduler run the Symfony app: they load secret env and
  // mount the per-instance JWT keypair read-only. Bind sources are resolved by
  // the ENGINE: relative when manager + engine share the path, absolute
  // engine-side otherwise. The env_file entries above stay relative either way
  // (they are read client-side by the compose CLI inside the manager).
  const jwtHostDir = spec.hostBindDir ? `${spec.hostBindDir}/secrets/jwt` : JWT_KEYS_HOST_DIR;
  const jwtMount = `${jwtHostDir}:${JWT_KEYS_CONTAINER_DIR}:ro`;
  const envHostFile = spec.hostBindDir ? `${spec.hostBindDir}/.env` : ENV_HOST_FILE;
  const dotenvMount = `${envHostFile}:${ENV_CONTAINER_FILE}:ro`;

  // Persistent application data shared by all three Symfony services so uploads
  // and installed plugin artifacts survive container replacement and are
  // captured by backups.
  const persistentMounts = [
    `${UPLOADS_VOLUME}:${UPLOADS_CONTAINER_DIR}`,
    `${PLUGIN_ARTIFACTS_VOLUME}:${PLUGIN_ARTIFACTS_CONTAINER_DIR}`,
    `${PLUGIN_ARTIFACTS_PUBLIC_VOLUME}:${PLUGIN_ARTIFACTS_PUBLIC_CONTAINER_DIR}`,
  ];

  // One-shot ownership hand-off for the named data volumes. The engine creates
  // them root-owned, but Symfony writes as www-data (uid 33): the first plugin
  // install/upload would fail with `mkdir(): Permission denied`. This service
  // (the backend image run as root) chowns the mount points and exits; the
  // Symfony services gate on its successful completion. It re-runs on every
  // `compose up` and is idempotent + instant.
  const volumeInit: Record<string, unknown> = {
    image: spec.images.backend,
    user: '0',
    entrypoint: ['sh', '-c'],
    command: [
      `chown ${APP_RUNTIME_UID}:${APP_RUNTIME_UID} ${UPLOADS_CONTAINER_DIR} ${PLUGIN_ARTIFACTS_CONTAINER_DIR} ${PLUGIN_ARTIFACTS_PUBLIC_CONTAINER_DIR}`,
    ],
    networks: ['instance'],
    volumes: [...persistentMounts],
    logging: loggingBlock(spec.resources),
    healthcheck: { disable: true },
  };
  const volumeInitGate = {
    [VOLUME_INIT_SERVICE]: { condition: 'service_completed_successfully' },
  };

  const backend = baseService(spec.images.backend, ['instance'], spec.resources, SECRET_AWARE_ENV);
  backend.volumes = [dotenvMount, jwtMount, ...persistentMounts];
  backend.depends_on = {
    ...volumeInitGate,
    mysql: { condition: 'service_healthy' },
    redis: { condition: 'service_healthy' },
  };

  // The worker/scheduler images are built FROM the backend image and inherit
  // its FrankenPHP HEALTHCHECK (curl to the Caddy admin endpoint :2019), but
  // these services run console loops, not FrankenPHP — the inherited check can
  // never pass and permanently brands working containers "unhealthy" in
  // `docker ps`. Disable it: `restart: unless-stopped` is the liveness
  // mechanism for these processes, and the manager's own health verdict probes
  // the public HTTP surface, never the Docker health flag of these two.
  const worker = baseService(spec.images.worker, ['instance'], spec.resources, SECRET_AWARE_ENV);
  worker.volumes = [dotenvMount, jwtMount, ...persistentMounts];
  worker.depends_on = { ...volumeInitGate, backend: { condition: 'service_started' } };
  worker.healthcheck = { disable: true };

  const scheduler = baseService(spec.images.scheduler, ['instance'], spec.resources, SECRET_AWARE_ENV);
  scheduler.volumes = [dotenvMount, jwtMount, ...persistentMounts];
  scheduler.depends_on = { ...volumeInitGate };
  scheduler.healthcheck = { disable: true };
  // `$$` defers expansion to the container shell (see the redis note below).
  scheduler.command = [
    'sh',
    '-lc',
    `while true; do php bin/console app:scheduled-jobs:execute-due --env=prod --no-interaction; sleep $\${SCHEDULED_JOBS_TICK_SECONDS:-${tick}}; done`,
  ];

  const mysql = baseService(spec.images.mysql, ['instance'], spec.resources, SECRET_AWARE_ENV);
  mysql.volumes = ['mysql_data:/var/lib/mysql'];
  // The canonical baseline migration creates stored functions/procedures. With
  // MySQL 8.x binary logging enabled (the default), the non-root application
  // user cannot create routines unless the server trusts function creators, so
  // the install-time `doctrine:migrations:migrate` would otherwise abort with
  // error 1419 ("You do not have the SUPER privilege and binary logging is
  // enabled"). Passing the flag here (the entrypoint prepends `mysqld`) keeps
  // the app DB user non-privileged while letting the baseline install.
  mysql.command = ['--log-bin-trust-function-creators=1'];
  mysql.healthcheck = {
    test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
    interval: '10s',
    timeout: '5s',
    retries: 10,
  };

  // Redis enforces the generated password; both the server and the healthcheck
  // read it from the container environment (loaded via the secret env_file).
  // `$$` is the compose-file escape: a single `$REDIS_PASSWORD` would be
  // interpolated by `docker compose` at PARSE time from the host env / project
  // `.env` (where the secret deliberately does not exist), silently starting
  // redis with an EMPTY --requirepass and warning "REDIS_PASSWORD is not set"
  // on every compose invocation. Escaped, the literal `$REDIS_PASSWORD`
  // reaches the container shell, which expands it from the secret env_file.
  const redis = baseService(spec.images.redis, ['instance'], spec.resources, SECRET_AWARE_ENV);
  redis.command = ['sh', '-lc', 'exec redis-server --requirepass "$$REDIS_PASSWORD"'];
  redis.healthcheck = {
    test: ['CMD-SHELL', 'redis-cli -a "$$REDIS_PASSWORD" ping | grep -q PONG'],
    interval: '10s',
    timeout: '5s',
    retries: 10,
  };

  // The hub serves plain HTTP on :80; TLS terminates at the edge proxy.
  // Without SERVER_NAME the dunglas/mercure Caddy defaults to auto-HTTPS on a
  // self-minted local CA and 308-redirects plain HTTP, so the backend's
  // publishes to http://mercure/.well-known/mercure would never work.
  //
  // Production additionally routes the hub at the edge under
  // https://<domain>/.well-known/mercure: subscribers (the frontend BFF and
  // mobile apps) connect via MERCURE_PUBLIC_URL, and without this router the
  // path fell through to the frontend's catch-all Host() rule and 404'd —
  // every events subscription failed. Traefik prefers the longer rule, so the
  // Host && PathPrefix router wins over the frontend's bare Host router for
  // exactly this path. Local mode keeps the hub private (the BFF subscribes
  // over the instance network).
  const mercureNetworks = spec.mode === 'production' ? ['instance', proxyNetwork] : ['instance'];
  const mercure = baseService(spec.images.mercure, mercureNetworks, spec.resources, SECRET_AWARE_ENV);
  mercure.environment = { SERVER_NAME: ':80' };
  if (spec.mode === 'production') {
    const domain = spec.domain;
    if (!domain) throw new Error('Production compose requires a domain.');
    mercure.labels = [
      'traefik.enable=true',
      `traefik.docker.network=${proxyNetwork}`,
      `traefik.http.routers.${id}-mercure.rule=Host(\`${domain}\`) && PathPrefix(\`/.well-known/mercure\`)`,
      `traefik.http.routers.${id}-mercure.entrypoints=websecure`,
      `traefik.http.routers.${id}-mercure.tls=true`,
      `traefik.http.routers.${id}-mercure.tls.certresolver=letsencrypt`,
      `traefik.http.services.${id}-mercure.loadbalancer.server.port=80`,
    ];
  }

  const services: Record<string, unknown> = {
    frontend,
    [VOLUME_INIT_SERVICE]: volumeInit,
    backend,
    worker,
    scheduler,
    mysql,
    redis,
    mercure,
  };

  // Optional mobile-preview service: only when the instance opted in (an image
  // ref is present). It edge-routes under /mobile-preview in production and
  // proxies a narrow allowlist of /cms-api calls to the PRIVATE backend over the
  // instance network. The image is the shared selfhelp-mobile-preview build; it
  // talks to the backend by service name, so the backend stays private (no
  // router of its own). The open-on-web plugin fallback derives the frontend
  // origin from the browser, so production (preview + frontend share the Traefik
  // host) needs no per-instance frontend-origin env.
  if (spec.images.mobilePreview) {
    const previewNetworks = spec.mode === 'production' ? ['instance', proxyNetwork] : ['instance'];
    const mobilePreview = baseService(spec.images.mobilePreview, previewNetworks, spec.resources, []);
    // The preview server reads ONLY its own (non-secret) env; it never loads the
    // Symfony .env, so an empty env_file list keeps baseService from attaching
    // one. Its config is set explicitly here.
    delete mobilePreview.env_file;
    mobilePreview.environment = {
      PORT: String(MOBILE_PREVIEW_INTERNAL_PORT),
      SELFHELP_PREVIEW_BASE_URL: MOBILE_PREVIEW_BASE_PATH,
      SELFHELP_BACKEND_INTERNAL_URL: `http://backend:${BACKEND_INTERNAL_PORT}`,
    };
    mobilePreview.depends_on = { backend: { condition: 'service_started' } };
    if (spec.mode === 'production') {
      const domain = spec.domain;
      if (!domain) throw new Error('Production compose requires a domain.');
      // Host && PathPrefix is more specific than the frontend's bare Host rule,
      // so Traefik routes /mobile-preview here (same mechanism as the Mercure
      // router above) while everything else falls through to the frontend.
      mobilePreview.labels = [
        'traefik.enable=true',
        `traefik.docker.network=${proxyNetwork}`,
        `traefik.http.routers.${id}-mobile-preview.rule=Host(\`${domain}\`) && PathPrefix(\`${MOBILE_PREVIEW_BASE_PATH}\`)`,
        `traefik.http.routers.${id}-mobile-preview.entrypoints=websecure`,
        `traefik.http.routers.${id}-mobile-preview.tls=true`,
        `traefik.http.routers.${id}-mobile-preview.tls.certresolver=letsencrypt`,
        `traefik.http.services.${id}-mobile-preview.loadbalancer.server.port=${MOBILE_PREVIEW_INTERNAL_PORT}`,
      ];
    } else if (spec.localPort !== undefined) {
      // Local mode: publish on a deterministic loopback port (frontend port +
      // 2000) for manual testing. The open-on-web fallback origin is the preview
      // host here (a known local-only limitation; production shares the host).
      mobilePreview.ports = [`127.0.0.1:${spec.localPort + 2000}:${MOBILE_PREVIEW_INTERNAL_PORT}`];
    }
    services['mobile-preview'] = mobilePreview;
  }

  if (includeMailpit) {
    const mailpit = baseService('axllent/mailpit:latest', ['instance'], spec.resources);
    if (spec.mode === 'local' && spec.localPort !== undefined) {
      mailpit.ports = [`127.0.0.1:${spec.localPort + 1000}:8025`];
    }
    services.mailpit = mailpit;
  }

  const networks: Record<string, unknown> = {
    instance: { name: `${composeProjectName(id)}_instance` },
    [proxyNetwork]: { external: true, name: proxyNetwork },
  };

  const volumes: Record<string, unknown> = {
    mysql_data: { name: `${composeProjectName(id)}_mysql_data` },
    [UPLOADS_VOLUME]: { name: `${composeProjectName(id)}_${UPLOADS_VOLUME}` },
    [PLUGIN_ARTIFACTS_VOLUME]: { name: `${composeProjectName(id)}_${PLUGIN_ARTIFACTS_VOLUME}` },
    [PLUGIN_ARTIFACTS_PUBLIC_VOLUME]: {
      name: `${composeProjectName(id)}_${PLUGIN_ARTIFACTS_PUBLIC_VOLUME}`,
    },
  };

  return { name: composeProjectName(id), services, networks, volumes };
}

export function composeToYaml(doc: ComposeDocument): string {
  return stringify(doc, { lineWidth: 0 });
}

export function generateInstanceComposeYaml(spec: InstanceComposeSpec): string {
  return composeToYaml(buildInstanceCompose(spec));
}
