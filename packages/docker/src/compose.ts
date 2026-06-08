// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Per-instance Docker Compose generation.
 *
 * Hard invariants enforced here (see the distribution plan):
 * - every instance gets its own networks/volumes and unique compose project;
 * - only the frontend container is attached to the shared proxy network;
 * - backend/worker/scheduler/db/redis/mercure stay on the private network;
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
 * Secret wiring conventions (kept in sync with `@shm/instances` secrets module).
 * Compose never inlines a secret value: it loads them from a `0600` env file and
 * mounts the JWT keypair read-only.
 */
const SECRETS_ENV_FILE = 'secrets/secrets.env';
const JWT_KEYS_HOST_DIR = './secrets/jwt';
const JWT_KEYS_CONTAINER_DIR = '/app/config/jwt';
const NON_SECRET_ENV = ['.env'];
const SECRET_AWARE_ENV = ['.env', SECRETS_ENV_FILE];

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
  // mount the per-instance JWT keypair read-only.
  const jwtMount = `${JWT_KEYS_HOST_DIR}:${JWT_KEYS_CONTAINER_DIR}:ro`;

  const backend = baseService(spec.images.backend, ['instance'], spec.resources, SECRET_AWARE_ENV);
  backend.volumes = [jwtMount];
  backend.depends_on = {
    mysql: { condition: 'service_healthy' },
    redis: { condition: 'service_healthy' },
  };

  const worker = baseService(spec.images.worker, ['instance'], spec.resources, SECRET_AWARE_ENV);
  worker.volumes = [jwtMount];
  worker.depends_on = { backend: { condition: 'service_started' } };

  const scheduler = baseService(spec.images.scheduler, ['instance'], spec.resources, SECRET_AWARE_ENV);
  scheduler.volumes = [jwtMount];
  scheduler.command = [
    'sh',
    '-lc',
    `while true; do php bin/console app:scheduled-jobs:execute-due --env=prod --no-interaction; sleep \${SCHEDULED_JOBS_TICK_SECONDS:-${tick}}; done`,
  ];

  const mysql = baseService(spec.images.mysql, ['instance'], spec.resources, SECRET_AWARE_ENV);
  mysql.volumes = ['mysql_data:/var/lib/mysql'];
  mysql.healthcheck = {
    test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
    interval: '10s',
    timeout: '5s',
    retries: 10,
  };

  // Redis enforces the generated password; both the server and the healthcheck
  // read it from the container environment (loaded via the secret env_file).
  const redis = baseService(spec.images.redis, ['instance'], spec.resources, SECRET_AWARE_ENV);
  redis.command = ['sh', '-lc', 'exec redis-server --requirepass "$REDIS_PASSWORD"'];
  redis.healthcheck = {
    test: ['CMD-SHELL', 'redis-cli -a "$REDIS_PASSWORD" ping | grep -q PONG'],
    interval: '10s',
    timeout: '5s',
    retries: 10,
  };

  const mercure = baseService(spec.images.mercure, ['instance'], spec.resources, SECRET_AWARE_ENV);

  const services: Record<string, unknown> = {
    frontend,
    backend,
    worker,
    scheduler,
    mysql,
    redis,
    mercure,
  };

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
    uploads: { name: `${composeProjectName(id)}_uploads` },
    plugin_artifacts: { name: `${composeProjectName(id)}_plugin_artifacts` },
  };

  return { name: composeProjectName(id), services, networks, volumes };
}

export function composeToYaml(doc: ComposeDocument): string {
  return stringify(doc, { lineWidth: 0 });
}

export function generateInstanceComposeYaml(spec: InstanceComposeSpec): string {
  return composeToYaml(buildInstanceCompose(spec));
}
