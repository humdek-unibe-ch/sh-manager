// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { InstanceManifest } from '@shm/schemas';
import { generateInstanceReadme } from './readme.js';

const manifest: InstanceManifest = {
  manifestVersion: 1,
  instanceId: 'website1',
  displayName: 'Website 1 Study',
  domain: 'website1.example.ch',
  mode: 'production',
  createdAt: '2026-06-05T10:00:00+00:00',
  updatedAt: '2026-06-05T10:00:00+00:00',
  registry: { id: 'selfhelp-official', url: 'https://registry.example/', channel: 'stable' },
  versions: { selfhelp: '1.4.2', backend: '1.4.2', frontend: '1.4.2', scheduler: '1.4.2', worker: '1.4.2', pluginApi: '2.1' },
  images: { backend: 'b', frontend: 'f', scheduler: 's', worker: 'w', mysql: 'mysql:8.4', redis: 'redis:7.2', mercure: 'dunglas/mercure:0.18' },
  routing: { publicFrontendUrl: 'https://website1.example.ch', browserApiPrefix: '/api', internalSymfonyUrl: 'http://backend:8080', symfonyApiPrefix: '/cms-api/v1' },
  installedPlugins: [],
};

describe('generateInstanceReadme', () => {
  const md = generateInstanceReadme(manifest, { managerVersion: '0.1.0', root: '/opt/selfhelp' });

  it('includes real manager commands and key paths', () => {
    expect(md).toContain('sh-manager instance update --dry-run website1');
    expect(md).toContain('selfhelp.instance.json');
    expect(md).toContain('https://website1.example.ch');
  });

  it('never prints secrets', () => {
    expect(md.toLowerCase()).not.toContain('app_secret');
    expect(md.toLowerCase()).not.toContain('private key');
    expect(md.toLowerCase()).not.toMatch(/password\s*[:=]/);
  });
});
