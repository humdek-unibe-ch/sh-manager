// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type {
  InstanceLock,
  InstanceManifest,
  RegistryIndex,
  SchedulerRelease,
  WorkerRelease,
} from './types.js';
import {
  validateInstanceLock,
  validateInstanceManifest,
  validateRegistryIndex,
  validateSchedulerRelease,
  validateWorkerRelease,
} from './validate.js';

const validManifest: InstanceManifest = {
  manifestVersion: 1,
  instanceId: 'website1',
  displayName: 'Website 1 Study',
  domain: 'website1.example.ch',
  mode: 'production',
  createdAt: '2026-06-05T10:00:00+00:00',
  updatedAt: '2026-06-05T10:00:00+00:00',
  registry: {
    id: 'selfhelp-official',
    url: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
    channel: 'stable',
  },
  versions: {
    selfhelp: '0.1.0',
    backend: '0.1.0',
    frontend: '0.1.0',
    scheduler: '0.1.0',
    worker: '0.1.0',
    pluginApi: '0.1.0',
  },
  images: {
    backend: 'ghcr.io/humdek-unibe-ch/selfhelp-backend:0.1.0',
    frontend: 'ghcr.io/humdek-unibe-ch/selfhelp-frontend:0.1.0',
    scheduler: 'ghcr.io/humdek-unibe-ch/selfhelp-scheduler:0.1.0',
    worker: 'ghcr.io/humdek-unibe-ch/selfhelp-worker:0.1.0',
    mysql: 'mysql:8.4',
    redis: 'redis:7.2',
    mercure: 'dunglas/mercure:0.18',
  },
  routing: {
    publicFrontendUrl: 'https://website1.example.ch',
    browserApiPrefix: '/api',
    internalSymfonyUrl: 'http://website1-backend:8080',
    symfonyApiPrefix: '/cms-api/v1',
  },
  installedPlugins: [{ id: 'survey-js', version: '0.1.0' }],
};

const validLock: InstanceLock = {
  lockfileVersion: 1,
  generatedAt: '2026-06-05T10:00:00+00:00',
  registry: {
    id: 'selfhelp-official',
    url: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
    metadataSha256: 'sha256:abc',
  },
  core: {
    version: '0.1.0',
    backendImageDigest: 'sha256:b',
    frontendImageDigest: 'sha256:f',
    schedulerImageDigest: 'sha256:s',
    workerImageDigest: 'sha256:w',
    migrationVersion: 'Version20260605081254',
    pluginApiVersion: '0.1.0',
    signedPayloadSha256: 'sha256:p',
  },
  services: {
    mysql: { image: 'mysql:8.4', digest: 'sha256:m' },
    redis: { image: 'redis:7.2', digest: 'sha256:r' },
    mercure: { image: 'dunglas/mercure:0.18', digest: 'sha256:me' },
  },
  plugins: {
    'survey-js': {
      version: '0.1.0',
      artifactSha256: 'sha256:a',
      signature: 'sig',
      keyId: 'humdek-2026-01',
      compatibility: { core: '>=0.1.0 <0.2.0', pluginApi: '0.1.0' },
    },
  },
};

const validRegistry: RegistryIndex = {
  schemaVersion: '1.0',
  requiresManager: '>=0.1.0 <2.0.0',
  publishedAt: '2026-06-05T10:00:00Z',
  baseUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
  publisher: { name: 'Humdek', url: 'https://github.com/humdek-unibe-ch' },
  core: [
    {
      id: 'selfhelp-core',
      version: '0.1.0',
      channel: 'stable',
      releaseUrl: 'core/releases/selfhelp-core-0.1.0.json',
    },
  ],
  frontend: [
    {
      id: 'selfhelp-frontend',
      version: '0.1.0',
      channel: 'stable',
      releaseUrl: 'frontend/releases/selfhelp-frontend-0.1.0.json',
    },
  ],
  scheduler: [],
  worker: [],
  plugins: [],
};

describe('validateInstanceManifest', () => {
  it('accepts a valid manifest', () => {
    const r = validateInstanceManifest(validManifest);
    expect(r.valid).toBe(true);
    expect(r.value?.instanceId).toBe('website1');
  });

  it('rejects a manifest missing required fields', () => {
    const broken = { ...validManifest } as Record<string, unknown>;
    delete broken.routing;
    const r = validateInstanceManifest(broken);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/routing/);
  });

  it('rejects an invalid instanceId pattern', () => {
    const r = validateInstanceManifest({ ...validManifest, instanceId: 'Bad Id!' });
    expect(r.valid).toBe(false);
  });

  it('tolerates unknown forward-compatible fields', () => {
    const r = validateInstanceManifest({ ...validManifest, futureField: 42 });
    expect(r.valid).toBe(true);
  });
});

describe('validateInstanceLock', () => {
  it('accepts a valid lock file', () => {
    expect(validateInstanceLock(validLock).valid).toBe(true);
  });
  it('rejects a lock missing core digests', () => {
    const broken = JSON.parse(JSON.stringify(validLock));
    delete broken.core.backendImageDigest;
    expect(validateInstanceLock(broken).valid).toBe(false);
  });
});

describe('validateRegistryIndex', () => {
  it('accepts a valid unified registry index', () => {
    expect(validateRegistryIndex(validRegistry).valid).toBe(true);
  });
  it('rejects an index without required release arrays', () => {
    const broken = { ...validRegistry } as Record<string, unknown>;
    delete broken.core;
    expect(validateRegistryIndex(broken).valid).toBe(false);
  });
  it('accepts an index with populated scheduler/worker arrays', () => {
    const idx: RegistryIndex = {
      ...validRegistry,
      scheduler: [{ id: 'selfhelp-scheduler-0.1.0', version: '0.1.0', channel: 'stable', releaseUrl: 'releases/scheduler/selfhelp-scheduler-0.1.0.json' }],
      worker: [{ id: 'selfhelp-worker-0.1.0', version: '0.1.0', channel: 'stable', releaseUrl: 'releases/worker/selfhelp-worker-0.1.0.json' }],
    };
    expect(validateRegistryIndex(idx).valid).toBe(true);
  });
  it('accepts the test (staging/rehearsal) channel on release refs', () => {
    const idx: RegistryIndex = {
      ...validRegistry,
      core: [{ id: 'selfhelp-core-0.1.0', version: '0.1.0', channel: 'test', releaseUrl: 'releases/core/selfhelp-core-0.1.0.json' }],
    };
    expect(validateRegistryIndex(idx).valid).toBe(true);
  });
  it('rejects an unknown release channel', () => {
    const idx = {
      ...validRegistry,
      core: [{ id: 'c', version: '0.1.0', channel: 'alpha', releaseUrl: 'x' }],
    } as unknown as RegistryIndex;
    expect(validateRegistryIndex(idx).valid).toBe(false);
  });
});

const validScheduler: SchedulerRelease = {
  kind: 'selfhelp-scheduler-release',
  id: 'selfhelp-scheduler-0.1.0',
  version: '0.1.0',
  channel: 'stable',
  image: 'ghcr.io/humdek-unibe-ch/selfhelp-scheduler:0.1.0',
  digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  backendCompatibility: { requiredCoreRange: '>=0.1.0 <0.2.0' },
  security: { signature: 's', keyId: 'selfhelp-dev-fixture' },
};

const validWorker: WorkerRelease = {
  ...validScheduler,
  kind: 'selfhelp-worker-release',
  id: 'selfhelp-worker-0.1.0',
  image: 'ghcr.io/humdek-unibe-ch/selfhelp-worker:0.1.0',
  digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
};

describe('validateSchedulerRelease / validateWorkerRelease', () => {
  it('accepts valid scheduler and worker releases', () => {
    expect(validateSchedulerRelease(validScheduler).valid).toBe(true);
    expect(validateWorkerRelease(validWorker).valid).toBe(true);
  });

  it('rejects the wrong kind', () => {
    expect(validateSchedulerRelease({ ...validScheduler, kind: 'selfhelp-worker-release' }).valid).toBe(false);
    expect(validateWorkerRelease({ ...validWorker, kind: 'selfhelp-scheduler-release' }).valid).toBe(false);
  });

  it('rejects a release missing backendCompatibility.requiredCoreRange', () => {
    const broken = JSON.parse(JSON.stringify(validScheduler));
    delete broken.backendCompatibility.requiredCoreRange;
    expect(validateSchedulerRelease(broken).valid).toBe(false);
  });

  it('rejects a release missing the signature block', () => {
    const broken = { ...validWorker } as Record<string, unknown>;
    delete broken.security;
    expect(validateWorkerRelease(broken).valid).toBe(false);
  });
});
