// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Fast (Docker-free) coverage for the e2e harness pieces that run in the PR
 * gate: the static registry server and the deterministic dev signer. The heavy
 * install/update scenarios live in docker-e2e.test.ts (gated by SHM_E2E).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateCoreRelease,
  validateFrontendRelease,
  validateSchedulerRelease,
  validateWorkerRelease,
} from '@shm/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { imageTags } from './build-images.mjs';
import { serveRegistry } from './serve-registry.mjs';
import {
  E2E_KEY_ID,
  canonicalStringify,
  coreRelease,
  devKeyPair,
  frontendRelease,
  serviceRelease,
  sign,
} from './build-test-registry.mjs';

const FAKE_DIGEST = `sha256:${'a'.repeat(64)}`;

describe('e2e harness: dev signer', () => {
  it('produces a signature that verifies against the deterministic dev key', () => {
    const body = { kind: 'selfhelp-core-release', id: 'selfhelp-core-8.0.0', version: '8.0.0', channel: 'test' };
    const security = sign(body);
    const payload = canonicalStringify(body);
    const kp = devKeyPair();

    expect(security.keyId).toBe(E2E_KEY_ID);
    expect(security.signedPayloadSha256).toBe(`sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`);
    const verified = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(payload, 'utf8')),
      new Uint8Array(Buffer.from(security.signature, 'base64')),
      kp.publicKey,
    );
    expect(verified).toBe(true);
  });

  it('canonicalises object keys regardless of insertion order', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });
});

describe('e2e harness: test-registry release builders match the manager schemas', () => {
  const tags = imageTags();
  const digests = { backend: FAKE_DIGEST, worker: FAKE_DIGEST, scheduler: FAKE_DIGEST };

  it('emits schema-valid, signed core/frontend/scheduler/worker releases on the test channel', () => {
    const core = coreRelease('8.0.0', tags, digests);
    const signedCore = { ...core, security: sign(core) };
    expect(validateCoreRelease(signedCore).valid).toBe(true);
    expect(signedCore.channel).toBe('test');

    const fe = frontendRelease('8.0.0', tags, FAKE_DIGEST);
    expect(validateFrontendRelease({ ...fe, security: sign(fe) }).valid).toBe(true);

    const sched = serviceRelease('selfhelp-scheduler-release', 'scheduler', '8.0.0', tags.scheduler, FAKE_DIGEST);
    expect(validateSchedulerRelease({ ...sched, security: sign(sched) }).valid).toBe(true);

    const worker = serviceRelease('selfhelp-worker-release', 'worker', '8.0.0', tags.worker, FAKE_DIGEST);
    expect(validateWorkerRelease({ ...worker, security: sign(worker) }).valid).toBe(true);
  });
});

describe('e2e harness: static registry server', () => {
  let dir: string;
  let server: { url: string; port: number; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('serves files, 404s missing paths, and refuses traversal', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'shm-serve-'));
    await mkdir(path.join(dir, 'releases', 'core'), { recursive: true });
    await writeFile(path.join(dir, 'registry.json'), JSON.stringify({ ok: true }), 'utf8');
    await writeFile(path.join(dir, 'releases', 'core', 'r.json'), JSON.stringify({ v: '8.0.0' }), 'utf8');

    const s = await serveRegistry(dir, 0);
    server = s;
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const idx = await fetch(`${s.url}registry.json`);
    expect(idx.status).toBe(200);
    expect(((await idx.json()) as { ok?: boolean }).ok).toBe(true);

    const nested = await fetch(`${s.url}releases/core/r.json`);
    expect(((await nested.json()) as { v?: string }).v).toBe('8.0.0');

    const missing = await fetch(`${s.url}nope.json`);
    expect(missing.status).toBe(404);

    const traversal = await fetch(`${s.url}..%2f..%2fpackage.json`);
    expect([403, 404]).toContain(traversal.status);
  });
});
