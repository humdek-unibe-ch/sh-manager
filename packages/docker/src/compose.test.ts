// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { InstanceImages } from '@shm/schemas';
import {
  buildInstanceCompose,
  composeProjectName,
  generateInstanceComposeYaml,
  type InstanceComposeSpec,
} from './compose.js';
import { assertComposeSafe, findDockerSocketMounts, findProxyNetworkViolations } from './guards.js';

const images: InstanceImages = {
  backend: 'ghcr.io/x/backend:1.5.0@sha256:b',
  frontend: 'ghcr.io/x/frontend:1.5.0@sha256:f',
  scheduler: 'ghcr.io/x/scheduler:1.5.0@sha256:s',
  worker: 'ghcr.io/x/worker:1.5.0@sha256:w',
  mysql: 'mysql:8.4',
  redis: 'redis:7.2',
  mercure: 'dunglas/mercure:0.18',
};

const prodSpec: InstanceComposeSpec = {
  instanceId: 'website1',
  mode: 'production',
  domain: 'website1.example.ch',
  images,
};

function svc(doc: ReturnType<typeof buildInstanceCompose>, name: string): Record<string, unknown> {
  return (doc.services as Record<string, Record<string, unknown>>)[name]!;
}

describe('buildInstanceCompose (production)', () => {
  const doc = buildInstanceCompose(prodSpec);

  it('uses a unique compose project name', () => {
    expect(doc.name).toBe('selfhelp_website1');
    expect(composeProjectName('website1')).toBe('selfhelp_website1');
  });

  it('includes every required per-instance service incl. a scheduler', () => {
    const services = Object.keys(doc.services as object);
    for (const required of ['frontend', 'backend', 'worker', 'scheduler', 'mysql', 'redis', 'mercure']) {
      expect(services).toContain(required);
    }
  });

  it('attaches only the frontend to the shared proxy network', () => {
    expect(svc(doc, 'frontend').networks).toContain('selfhelp_proxy');
    expect(svc(doc, 'backend').networks).toEqual(['instance']);
    expect(findProxyNetworkViolations(doc)).toHaveLength(0);
  });

  it('keeps MySQL data in a per-instance persistent volume', () => {
    expect(svc(doc, 'mysql').volumes).toContain('mysql_data:/var/lib/mysql');
    const volumes = doc.volumes as Record<string, { name: string }>;
    expect(volumes.mysql_data!.name).toBe('selfhelp_website1_mysql_data');
  });

  it('trusts function creators so the baseline migration can install routines as the app user', () => {
    // Regression: without this flag MySQL 8.x (binary logging on by default)
    // rejects the baseline's CREATE FUNCTION/PROCEDURE statements for the
    // non-root app user with error 1419, breaking the install migration.
    expect((svc(doc, 'mysql').command as string[]).join(' ')).toContain(
      '--log-bin-trust-function-creators=1',
    );
  });

  it('configures log rotation for every long-running service', () => {
    for (const name of ['frontend', 'backend', 'worker', 'scheduler', 'mysql', 'redis', 'mercure']) {
      const logging = svc(doc, name).logging as { driver: string; options: Record<string, string> };
      expect(logging.driver).toBe('json-file');
      expect(logging.options['max-size']).toBe('10m');
      expect(logging.options['max-file']).toBe('5');
    }
  });

  it('never mounts the Docker socket', () => {
    expect(findDockerSocketMounts(doc)).toHaveLength(0);
  });

  it('loads secrets from a 0600 env file for every secret-aware service, but not the frontend', () => {
    for (const name of ['backend', 'worker', 'scheduler', 'mysql', 'redis', 'mercure']) {
      expect(svc(doc, name).env_file).toEqual(['.env', 'secrets/secrets.env']);
    }
    expect(svc(doc, 'frontend').env_file).toEqual(['.env']);
  });

  it('mounts the per-instance JWT keypair read-only into the Symfony services', () => {
    for (const name of ['backend', 'worker', 'scheduler']) {
      expect(svc(doc, name).volumes).toContain('./secrets/jwt:/app/config/jwt:ro');
    }
  });

  it('mounts persistent uploads + plugin-artifact volumes on every Symfony service', () => {
    for (const name of ['backend', 'worker', 'scheduler']) {
      const volumes = svc(doc, name).volumes as string[];
      expect(volumes).toContain('uploads:/app/public/uploads');
      expect(volumes).toContain('plugin_artifacts:/app/var/plugins');
      expect(volumes).toContain('plugin_artifacts_public:/app/public/plugin-artifacts');
    }
  });

  it('declares per-instance named volumes for uploads + both plugin-artifact paths', () => {
    const volumes = doc.volumes as Record<string, { name: string }>;
    expect(volumes.uploads!.name).toBe('selfhelp_website1_uploads');
    expect(volumes.plugin_artifacts!.name).toBe('selfhelp_website1_plugin_artifacts');
    expect(volumes.plugin_artifacts_public!.name).toBe('selfhelp_website1_plugin_artifacts_public');
  });

  it('enforces a Redis password without inlining it', () => {
    const redis = svc(doc, 'redis');
    expect((redis.command as string[]).join(' ')).toContain('requirepass');
    expect((redis.healthcheck as { test: string[] }).test.join(' ')).toContain('REDIS_PASSWORD');
  });

  it('never inlines a raw secret value in the compose document', () => {
    const yaml = generateInstanceComposeYaml(prodSpec);
    // Compose only references env files / env vars; it must not contain literal secrets.
    expect(yaml).toContain('secrets/secrets.env');
    expect(yaml).not.toMatch(/APP_SECRET=\S/);
    expect(yaml).not.toContain('BEGIN ENCRYPTED PRIVATE KEY');
  });

  it('emits routing labels for the production domain', () => {
    const labels = svc(doc, 'frontend').labels as string[];
    expect(labels.join(' ')).toContain('Host(`website1.example.ch`)');
  });

  it('passes the aggregated safety guard', () => {
    expect(() => assertComposeSafe(doc)).not.toThrow();
  });

  it('serialises to YAML', () => {
    const yaml = generateInstanceComposeYaml(prodSpec);
    expect(yaml).toContain('selfhelp_website1');
    expect(yaml).toContain('mercure');
  });
});

describe('buildInstanceCompose (local)', () => {
  const doc = buildInstanceCompose({
    instanceId: 'localtest',
    mode: 'local',
    localPort: 8081,
    images,
  });

  it('publishes the frontend on a localhost port and includes Mailpit', () => {
    expect(svc(doc, 'frontend').ports).toEqual(['127.0.0.1:8081:3000']);
    expect(Object.keys(doc.services as object)).toContain('mailpit');
  });

  it('still isolates networks/volumes per instance', () => {
    const volumes = doc.volumes as Record<string, { name: string }>;
    expect(volumes.mysql_data!.name).toBe('selfhelp_localtest_mysql_data');
    expect(findProxyNetworkViolations(doc)).toHaveLength(0);
  });
});

describe('resource limits', () => {
  it('applies optional memory/cpu limits and custom log rotation', () => {
    const doc = buildInstanceCompose({
      ...prodSpec,
      resources: { memoryLimitMb: 512, cpuLimit: 1, logMaxSizeMb: 20, logMaxFiles: 3 },
    });
    const deploy = svc(doc, 'backend').deploy as { resources: { limits: Record<string, string> } };
    expect(deploy.resources.limits.memory).toBe('512M');
    expect(deploy.resources.limits.cpus).toBe('1');
    const logging = svc(doc, 'backend').logging as { options: Record<string, string> };
    expect(logging.options['max-size']).toBe('20m');
  });
});
