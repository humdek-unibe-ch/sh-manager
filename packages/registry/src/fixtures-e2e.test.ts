// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TrustedKeysFile } from '@shm/schemas';
import { RegistryClient, RegistryError, type Fetcher, type FetchResponse } from './client.js';

const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', 'examples');

async function read(name: string): Promise<string> {
  return readFile(path.join(examplesDir, name), 'utf8');
}

class FixtureFetcher implements Fetcher {
  constructor(private readonly map: Record<string, string>) {}
  async fetch(url: string): Promise<FetchResponse> {
    for (const [suffix, body] of Object.entries(this.map)) {
      if (url.endsWith(suffix)) return { ok: true, status: 200, text: body };
    }
    return { ok: false, status: 404, text: '' };
  }
}

const BASE = 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/';
let trustedKeys: TrustedKeysFile;
let indexBody: string;
let coreBody: string;
let frontendBody: string;

beforeAll(async () => {
  trustedKeys = JSON.parse(await read('trusted-keys.json')) as TrustedKeysFile;
  indexBody = await read('registry-index.json');
  coreBody = await read('core-release.json');
  frontendBody = await read('frontend-release.json');
});

function client(map: Record<string, string>): RegistryClient {
  return new RegistryClient({ baseUrl: BASE, trustedKeys, managerVersion: '0.1.0', fetcher: new FixtureFetcher(map) });
}

describe('RegistryClient end-to-end with signed fixtures', () => {
  it('fetches + validates + schema-gates the index and records a check', async () => {
    const c = client({ 'registry.json': indexBody });
    const index = await c.getIndex();
    expect(index.core[0]?.version).toBe('8.0.0');
    expect(c.lastSuccessfulCheck?.metadataSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a signed core + frontend release', async () => {
    const c = client({
      'registry.json': indexBody,
      'selfhelp-core-8.0.0.json': coreBody,
      'selfhelp-frontend-8.0.0.json': frontendBody,
    });
    const index = await c.getIndex();
    const core = await c.getCoreRelease(index.core[0]!);
    expect(core.verification.verified).toBe(true);
    const fe = await c.getFrontendRelease(index.frontend[0]!);
    expect(fe.verification.verified).toBe(true);
  });

  it('rejects a tampered release (signature mismatch)', async () => {
    const tampered = coreBody.replace('"8.0.0"', '"9.9.9"');
    const c = client({ 'registry.json': indexBody, 'selfhelp-core-8.0.0.json': tampered });
    const index = await c.getIndex();
    await expect(c.getCoreRelease(index.core[0]!)).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('reports manager_outdated when the registry requires a newer manager', async () => {
    const newer = indexBody.replace('">=0.1.0"', '">=99.0.0"');
    const c = client({ 'registry.json': newer });
    await expect(c.getIndex()).rejects.toBeInstanceOf(RegistryError);
  });
});
