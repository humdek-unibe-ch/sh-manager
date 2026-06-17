// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * End-to-end regression for the frontend/core compatibility bypass.
 *
 * The running core's `frontendCompatibility.requiredFrontendRange` must ALWAYS
 * gate a frontend-only update. Before the fix, when the installed core release
 * was no longer in the registry index the manager fell back to checking only the
 * candidate frontend's own `requiredCoreRange`, silently dropping the core's
 * constraint and letting an incompatible frontend through.
 *
 * These tests drive the REAL install + frontend-update action code against a
 * signed in-memory fixture registry (no Docker / no network), then point the
 * frontend update at a registry where the installed core has been REMOVED, and
 * assert the constraint is still enforced from the value persisted in the
 * instance lock — and that a missing range fails closed with operator guidance.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import type { TrustedKeysFile } from '@shm/schemas';
import { RecordingComposeRunner, type ComposeResult } from '@shm/docker';
import { canonicalize, sha256Hex, type Fetcher, type FetchResponse } from '@shm/registry';
import { LockStore, ManifestStore } from '@shm/instances';
import type { ActionDeps } from './actions.js';
import { instanceFrontendUpdate, instanceInstall, serverInit } from './actions.js';

const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'schemas', 'examples');
const readExample = (n: string): Promise<string> => readFile(path.join(examplesDir, n), 'utf8');

const DEV_KEY_ID = 'selfhelp-dev-fixture';
const devSeed = createHash('sha256').update('selfhelp-dev-registry-signing-key-v1').digest();
const devKeyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(devSeed));

/** Sign a release body (without its `security` block) with the dev key. */
function sign(bodyWithoutSecurity: Record<string, unknown>): Record<string, string> {
  const payload = canonicalize(bodyWithoutSecurity);
  const sig = nacl.sign.detached(new Uint8Array(Buffer.from(payload, 'utf8')), devKeyPair.secretKey);
  return {
    signature: Buffer.from(sig).toString('base64'),
    keyId: DEV_KEY_ID,
    signedPayloadSha256: `sha256:${sha256Hex(payload)}`,
  };
}

/** A fetcher that resolves registry URLs by suffix against an in-memory map. */
class FixtureFetcher implements Fetcher {
  constructor(private readonly map: Record<string, string>) {}
  async fetch(url: string): Promise<FetchResponse> {
    for (const [suffix, body] of Object.entries(this.map)) if (url.endsWith(suffix)) return { ok: true, status: 200, text: body };
    return { ok: false, status: 404, text: '' };
  }
}

const REGISTRY_URL = 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/';

interface FrontendSpec {
  version: string;
  requiredCoreRange: string;
}

/** Mints a dev-signed frontend release body from the committed 0.1.0 example. */
async function mintFrontend(spec: FrontendSpec): Promise<{ filename: string; body: string; ref: Record<string, string> }> {
  const base = JSON.parse(await readExample('frontend-release.json')) as Record<string, unknown> & { security?: unknown };
  const { security: _drop, ...body } = base;
  body.id = `selfhelp-frontend-${spec.version}`;
  body.version = spec.version;
  body.image = `ghcr.io/humdek-unibe-ch/selfhelp-frontend:${spec.version}`;
  body.digest = `sha256:${createHash('sha256').update(`frontend-${spec.version}`).digest('hex')}`;
  body.backendCompatibility = { requiredCoreRange: spec.requiredCoreRange, requiredApiVersion: '0.1.0' };
  const signed = JSON.stringify({ ...body, security: sign(body) });
  const filename = `selfhelp-frontend-${spec.version}.json`;
  return {
    filename,
    body: signed,
    ref: { id: body.id as string, version: spec.version, channel: 'stable', releaseUrl: `releases/frontend/${filename}` },
  };
}

/**
 * Build a registry. `includeCore010` controls whether the installed core 0.1.0
 * is still present in the index — omitting it reproduces "the running core left
 * the registry", the exact condition that used to bypass the constraint.
 */
async function buildRegistry(opts: { includeCore010: boolean; frontends: FrontendSpec[] }): Promise<Record<string, string>> {
  const core010 = await readExample('core-release.json');
  const minted = await Promise.all(opts.frontends.map(mintFrontend));

  const index = {
    schemaVersion: '1.0',
    requiresManager: '>=0.1.0',
    publishedAt: '2026-06-05T12:00:00Z',
    baseUrl: REGISTRY_URL,
    publisher: { name: 'SelfHelp (University of Bern)', url: 'https://www.unibe.ch/' },
    core: opts.includeCore010
      ? [{ id: 'selfhelp-core-0.1.0', version: '0.1.0', channel: 'stable', releaseUrl: 'releases/core/selfhelp-core-0.1.0.json' }]
      : [],
    frontend: minted.map((m) => m.ref),
    scheduler: [],
    worker: [],
    plugins: [],
  };

  const map: Record<string, string> = {
    'registry.json': JSON.stringify(index),
    'selfhelp-core-0.1.0.json': core010,
  };
  for (const m of minted) map[m.filename] = m.body;
  return map;
}

let root: string;
let trustedKeys: TrustedKeysFile;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-feupd-'));
  trustedKeys = JSON.parse(await readExample('trusted-keys.json')) as TrustedKeysFile;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeDeps(registryMap: Record<string, string>): ActionDeps {
  const digest = `sha256:${'a'.repeat(64)}`;
  const runner = new RecordingComposeRunner((): ComposeResult => ({ stdout: '', stderr: '' }));
  return {
    root,
    managerVersion: '0.1.0',
    trustedKeys,
    runner,
    fetcher: new FixtureFetcher(registryMap),
    resolveServiceDigests: async (images) => ({
      mysql: { image: images.mysql, digest },
      redis: { image: images.redis, digest },
      mercure: { image: images.mercure, digest },
    }),
    probeHealth: async () => [
      { service: 'backend', ok: true, detail: 'HTTP 200' },
      { service: 'frontend', ok: true, detail: 'HTTP 200' },
    ],
    resourceFacts: async (ports) => ({
      requiredPortsFree: ports.map((p) => ({ port: p, free: true })),
      diskBytesFree: 100 * 1024 * 1024 * 1024,
      memoryBytesTotal: 16 * 1024 * 1024 * 1024,
      cpuCount: 8,
      dockerAvailable: true,
      dockerComposeAvailable: true,
    }),
    now: () => '2026-06-09T08:00:00.000Z',
    sleep: async () => {},
    dbWaitDelayMs: 0,
  };
}

/** Installs a local instance on core 0.1.0 / frontend 0.1.0 (no bring-up). */
async function installBaseInstance(instanceId: string): Promise<void> {
  const deps = makeDeps(await buildRegistry({ includeCore010: true, frontends: [{ version: '0.1.0', requiredCoreRange: '>=0.1.0 <0.2.0' }] }));
  await serverInit(deps, { serverId: 'srv-feupd', mode: 'local' });
  const res = await instanceInstall(deps, {
    instanceId,
    displayName: instanceId,
    mode: 'local',
    localPort: 8090,
    registryUrl: REGISTRY_URL,
    version: '0.1.0',
    bringUp: false,
  });
  expect(res.version).toBe('0.1.0');
}

describe('instanceFrontendUpdate – running-core compatibility enforcement (offline, signed registry)', () => {
  it('install persists the core required frontend range in the lock', async () => {
    await installBaseInstance('feupd-persist');
    const lock = await new LockStore('feupd-persist', root).read();
    // The committed example core 0.1.0 declares ">=0.1.0 <0.2.0".
    expect(lock.core.requiredFrontendRange).toBe('>=0.1.0 <0.2.0');
  });

  it('BLOCKS an incompatible frontend from the lock range even when the core left the registry', async () => {
    await installBaseInstance('feupd-block');
    // Core 0.1.0 is gone from the registry; frontend 0.2.0 accepts core 0.1.0 via
    // its requiredCoreRange but is OUTSIDE the core's stored required frontend
    // range (">=0.1.0 <0.2.0"), so it must be blocked.
    const updateDeps = makeDeps(
      await buildRegistry({
        includeCore010: false,
        frontends: [
          { version: '0.1.0', requiredCoreRange: '>=0.1.0 <0.2.0' },
          { version: '0.2.0', requiredCoreRange: '>=0.1.0 <0.3.0' },
        ],
      }),
    );

    const res = await instanceFrontendUpdate(updateDeps, 'feupd-block', { target: '0.2.0' });
    expect(res.executed).toBe(false);
    expect(res.plan.status).toBe('blocked');
    expect(res.plan.frontend).toBeNull();
    expect(res.plan.reasons.join(' ')).toMatch(/not accepted by the running SelfHelp core 0\.1\.0/i);

    // The frontend version on disk is unchanged.
    const manifest = await new ManifestStore('feupd-block', root).read();
    expect(manifest.versions.frontend).toBe('0.1.0');
  });

  it('ALLOWS a compatible frontend from the lock range when the core left the registry, and keeps the range', async () => {
    await installBaseInstance('feupd-allow');
    const updateDeps = makeDeps(
      await buildRegistry({
        includeCore010: false,
        frontends: [
          { version: '0.1.0', requiredCoreRange: '>=0.1.0 <0.2.0' },
          { version: '0.1.5', requiredCoreRange: '>=0.1.0 <0.2.0' },
        ],
      }),
    );

    const res = await instanceFrontendUpdate(updateDeps, 'feupd-allow', { target: '0.1.5' });
    expect(res.plan.status).toBe('ok');
    expect(res.executed).toBe(true);
    expect(res.report?.ok).toBe(true);

    const manifest = await new ManifestStore('feupd-allow', root).read();
    const lock = await new LockStore('feupd-allow', root).read();
    expect(manifest.versions.frontend).toBe('0.1.5');
    // Core untouched, and the stored range is carried forward (not lost to "*").
    expect(lock.core.version).toBe('0.1.0');
    expect(lock.core.requiredFrontendRange).toBe('>=0.1.0 <0.2.0');
  });

  it('FAILS CLOSED with operator guidance for a pre-1.6 lock (no stored range) whose core left the registry', async () => {
    await installBaseInstance('feupd-legacy');
    // Simulate a lock written before the range was persisted.
    const store = new LockStore('feupd-legacy', root);
    const lock = await store.read();
    delete (lock.core as { requiredFrontendRange?: string }).requiredFrontendRange;
    await store.write(lock);

    const updateDeps = makeDeps(
      await buildRegistry({
        includeCore010: false,
        frontends: [
          { version: '0.1.0', requiredCoreRange: '>=0.1.0 <0.2.0' },
          { version: '0.1.5', requiredCoreRange: '>=0.1.0 <0.2.0' },
        ],
      }),
    );

    const res = await instanceFrontendUpdate(updateDeps, 'feupd-legacy', { target: '0.1.5' });
    expect(res.executed).toBe(false);
    expect(res.plan.status).toBe('blocked');
    expect(res.plan.reasons.join(' ')).toMatch(/no longer in the registry/i);
    expect(res.plan.reasons.join(' ')).toMatch(/Update the core first/i);
  });

  it('still enforces the LIVE registry core range when the core is present', async () => {
    await installBaseInstance('feupd-live');
    // Core 0.1.0 is still published (range ">=0.1.0 <0.2.0"); frontend 0.2.0 is
    // forbidden by the live release, independent of the lock.
    const updateDeps = makeDeps(
      await buildRegistry({
        includeCore010: true,
        frontends: [
          { version: '0.1.0', requiredCoreRange: '>=0.1.0 <0.2.0' },
          { version: '0.2.0', requiredCoreRange: '>=0.1.0 <0.3.0' },
        ],
      }),
    );

    const res = await instanceFrontendUpdate(updateDeps, 'feupd-live', { target: '0.2.0' });
    expect(res.executed).toBe(false);
    expect(res.plan.status).toBe('blocked');
    expect(res.plan.reasons.join(' ')).toMatch(/not accepted by the running SelfHelp core 0\.1\.0/i);
  });
});
