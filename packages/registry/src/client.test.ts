// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import type { RegistryIndex, TrustedKeysFile } from '@shm/schemas';
import { canonicalize } from './canonical.js';
import { RegistryClient, RegistryError, type Fetcher, type FetchResponse } from './client.js';

const BASE = 'https://registry.example/';

class MapFetcher implements Fetcher {
  constructor(private readonly map: Record<string, FetchResponse>) {}
  async fetch(url: string): Promise<FetchResponse> {
    const hit = this.map[url];
    if (!hit) return { ok: false, status: 404, text: 'not found' };
    return hit;
  }
}

class ThrowingFetcher implements Fetcher {
  async fetch(): Promise<FetchResponse> {
    throw new Error('ENOTFOUND');
  }
}

function buildFixtures(overrides: Partial<RegistryIndex> = {}) {
  const kp = nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString('base64');
  const trustedKeys: TrustedKeysFile = {
    schemaVersion: '1.0',
    keys: [{ keyId: 'humdek-2026-01', publicKey, algorithm: 'ed25519', status: 'active' }],
  };

  const index: RegistryIndex = {
    schemaVersion: '1.0',
    requiresManager: '>=0.1.0 <2.0.0',
    publishedAt: '2026-06-05T10:00:00Z',
    baseUrl: BASE,
    publisher: { name: 'Humdek', url: 'https://github.com/humdek-unibe-ch' },
    core: [
      { id: 'selfhelp-core', version: '1.5.0', channel: 'stable', releaseUrl: 'core/releases/selfhelp-core-1.5.0.json' },
    ],
    frontend: [],
    scheduler: [],
    worker: [],
    plugins: [],
    ...overrides,
  };

  const coreBody: Record<string, unknown> = {
    kind: 'selfhelp-core-release',
    id: 'selfhelp-core',
    version: '1.5.0',
    channel: 'stable',
    minimumDirectUpgradeFrom: '1.3.0',
    pluginApiVersion: '2.2',
    backend: { image: 'ghcr.io/x/backend:1.5.0', digest: 'sha256:b', phpVersion: '8.4' },
    worker: { image: 'ghcr.io/x/worker:1.5.0', digest: 'sha256:w' },
    scheduler: { image: 'ghcr.io/x/scheduler:1.5.0', digest: 'sha256:s' },
    frontendCompatibility: { requiredFrontendRange: '>=1.5.0 <1.6.0' },
    database: { migrationRange: 'a-b', destructive: false, requiresBackup: true, manualConfirmationRequired: false },
  };
  const payload = canonicalize(coreBody);
  const signature = Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(payload, 'utf8')), kp.secretKey),
  ).toString('base64');
  const coreRelease = { ...coreBody, security: { signature, keyId: 'humdek-2026-01' } };

  return { index, coreRelease, trustedKeys };
}

function ok(text: string): FetchResponse {
  return { ok: true, status: 200, text, etag: 'W/"abc"' };
}

describe('RegistryClient.getIndex', () => {
  it('fetches, validates and records the last successful check', async () => {
    const { index, trustedKeys } = buildFixtures();
    const client = new RegistryClient({
      baseUrl: BASE,
      trustedKeys,
      fetcher: new MapFetcher({ [BASE + 'registry.json']: ok(JSON.stringify(index)) }),
      managerVersion: '0.1.0',
    });
    const result = await client.getIndex();
    expect(result.core[0]!.version).toBe('1.5.0');
    expect(client.lastSuccessfulCheck?.metadataSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an incompatible (newer major) registry schema', async () => {
    const { index, trustedKeys } = buildFixtures({ schemaVersion: '2.0' });
    const client = new RegistryClient({
      baseUrl: BASE,
      trustedKeys,
      fetcher: new MapFetcher({ [BASE + 'registry.json']: ok(JSON.stringify(index)) }),
    });
    await expect(client.getIndex()).rejects.toMatchObject({ code: 'schema_incompatible' });
  });

  it('reports manager_outdated when the registry requires a newer manager', async () => {
    const { index, trustedKeys } = buildFixtures({ requiresManager: '>=9.0.0' });
    const client = new RegistryClient({
      baseUrl: BASE,
      trustedKeys,
      fetcher: new MapFetcher({ [BASE + 'registry.json']: ok(JSON.stringify(index)) }),
      managerVersion: '0.1.0',
    });
    await expect(client.getIndex()).rejects.toMatchObject({ code: 'manager_outdated' });
  });

  it('reports registry_unavailable without throwing a raw error', async () => {
    const { trustedKeys } = buildFixtures();
    const client = new RegistryClient({ baseUrl: BASE, trustedKeys, fetcher: new ThrowingFetcher() });
    await expect(client.getIndex()).rejects.toBeInstanceOf(RegistryError);
    await expect(client.getIndex()).rejects.toMatchObject({ code: 'registry_unavailable' });
  });
});

describe('RegistryClient.getCoreRelease', () => {
  it('verifies a signed core release', async () => {
    const { index, coreRelease, trustedKeys } = buildFixtures();
    const client = new RegistryClient({
      baseUrl: BASE,
      trustedKeys,
      fetcher: new MapFetcher({
        [BASE + 'registry.json']: ok(JSON.stringify(index)),
        [BASE + 'core/releases/selfhelp-core-1.5.0.json']: ok(JSON.stringify(coreRelease)),
      }),
      managerVersion: '0.1.0',
    });
    const idx = await client.getIndex();
    const { release, verification } = await client.getCoreRelease(idx.core[0]!);
    expect(verification.verified).toBe(true);
    expect(release.version).toBe('1.5.0');
  });

  it('refuses a tampered core release in production', async () => {
    const { index, coreRelease, trustedKeys } = buildFixtures();
    const tampered = { ...coreRelease, version: '9.9.9' };
    const client = new RegistryClient({
      baseUrl: BASE,
      trustedKeys,
      fetcher: new MapFetcher({
        [BASE + 'registry.json']: ok(JSON.stringify(index)),
        [BASE + 'core/releases/selfhelp-core-1.5.0.json']: ok(JSON.stringify(tampered)),
      }),
      managerVersion: '0.1.0',
    });
    const idx = await client.getIndex();
    await expect(client.getCoreRelease(idx.core[0]!)).rejects.toMatchObject({ code: 'signature_invalid' });
  });
});
