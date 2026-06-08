// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstanceManifest, ServerInventory } from '@shm/schemas';
import { InventoryStore, ManifestStore, StoreValidationError } from './stores.js';
import { instancePaths } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const manifest: InstanceManifest = {
  manifestVersion: 1,
  instanceId: 'website1',
  displayName: 'Website 1',
  domain: 'website1.example.ch',
  mode: 'production',
  createdAt: '2026-06-05T10:00:00+00:00',
  updatedAt: '2026-06-05T10:00:00+00:00',
  registry: { id: 'selfhelp-official', url: 'https://registry.example/', channel: 'stable' },
  versions: {
    selfhelp: '1.4.2',
    backend: '1.4.2',
    frontend: '1.4.2',
    scheduler: '1.4.2',
    worker: '1.4.2',
    pluginApi: '2.1',
  },
  images: {
    backend: 'b',
    frontend: 'f',
    scheduler: 's',
    worker: 'w',
    mysql: 'mysql:8.4',
    redis: 'redis:7.2',
    mercure: 'dunglas/mercure:0.18',
  },
  routing: {
    publicFrontendUrl: 'https://website1.example.ch',
    browserApiPrefix: '/api',
    internalSymfonyUrl: 'http://backend:8080',
    symfonyApiPrefix: '/cms-api/v1',
  },
  installedPlugins: [],
};

const inventory: ServerInventory = {
  inventoryVersion: 1,
  serverId: 'server-001',
  manager: { name: 'SelfHelp Manager', repository: 'sh-manager', version: '0.1.0' },
  proxy: { type: 'traefik', network: 'selfhelp_proxy', composePath: '/opt/selfhelp/proxy/compose.yaml' },
  instances: [],
};

describe('ManifestStore', () => {
  it('writes and reads a manifest atomically (roundtrip)', async () => {
    const store = new ManifestStore('website1', root);
    await store.write(manifest);
    const read = await store.read();
    expect(read.instanceId).toBe('website1');
    expect(read.routing.browserApiPrefix).toBe('/api');
  });

  it('refuses to write an invalid manifest', async () => {
    const store = new ManifestStore('website1', root);
    const broken = { ...manifest, instanceId: 'NOT VALID' };
    await expect(store.write(broken)).rejects.toBeInstanceOf(StoreValidationError);
  });

  it('rejects an unknown major manifest schema version on read', async () => {
    const p = instancePaths('website1', root);
    await mkdir(path.dirname(p.manifestPath), { recursive: true });
    await writeFile(p.manifestPath, JSON.stringify({ ...manifest, manifestVersion: 99 }), 'utf8');
    const store = new ManifestStore('website1', root);
    await expect(store.read()).rejects.toThrow(/schema major/i);
  });
});

describe('InventoryStore', () => {
  it('upserts an instance entry and reads it back', async () => {
    const store = new InventoryStore(root);
    await store.write(inventory);
    await store.upsertInstance({
      instanceId: 'website1',
      domain: 'website1.example.ch',
      path: '/opt/selfhelp/instances/website1',
      composeProject: 'selfhelp_website1',
      status: 'active',
    });
    const read = await store.read();
    expect(read.instances).toHaveLength(1);
    expect(read.instances[0]!.composeProject).toBe('selfhelp_website1');
  });
});
