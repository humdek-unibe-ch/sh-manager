// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import type { TrustedKeysFile } from '@shm/schemas';
import { canonicalize } from './canonical.js';
import { verifyChecksum } from './checksum.js';
import { verifyEd25519, verifyReleaseSignature } from './signature.js';

function makeSignedRelease() {
  const kp = nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString('base64');
  const release: Record<string, unknown> = {
    kind: 'selfhelp-core-release',
    id: 'selfhelp-core',
    version: '1.5.0',
    channel: 'stable',
  };
  const payload = canonicalize(release);
  const signature = Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(payload, 'utf8')), kp.secretKey),
  ).toString('base64');
  const signed = { ...release, security: { signature, keyId: 'humdek-2026-01' } };
  const trusted: TrustedKeysFile = {
    schemaVersion: '1.0',
    keys: [{ keyId: 'humdek-2026-01', publicKey, algorithm: 'ed25519', status: 'active' }],
  };
  return { signed, trusted, publicKey, payload, signature };
}

describe('verifyEd25519', () => {
  it('verifies a valid detached signature and rejects tampering', () => {
    const { payload, signature, publicKey } = makeSignedRelease();
    expect(verifyEd25519(payload, signature, publicKey)).toBe(true);
    expect(verifyEd25519(payload + 'x', signature, publicKey)).toBe(false);
  });

  it('rejects malformed key/signature inputs without throwing', () => {
    expect(verifyEd25519('payload', 'not-base64!!', 'also-bad')).toBe(false);
  });
});

describe('verifyReleaseSignature', () => {
  it('verifies a release signed by a trusted active key', () => {
    const { signed, trusted } = makeSignedRelease();
    const r = verifyReleaseSignature(signed as never, trusted);
    expect(r.verified).toBe(true);
    expect(r.keyId).toBe('humdek-2026-01');
  });

  it('rejects an unsigned release', () => {
    const { trusted } = makeSignedRelease();
    const r = verifyReleaseSignature({ security: { signature: '', keyId: 'humdek-2026-01' } } as never, trusted);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/unsigned/i);
  });

  it('rejects a release signed with keyId "dev" in production', () => {
    const { signed, trusted } = makeSignedRelease();
    (signed.security as { keyId: string }).keyId = 'dev';
    const r = verifyReleaseSignature(signed as never, trusted);
    expect(r.verified).toBe(false);
  });

  it('rejects a release whose key is revoked', () => {
    const { signed, trusted } = makeSignedRelease();
    trusted.keys[0]!.status = 'revoked';
    const r = verifyReleaseSignature(signed as never, trusted);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/no active trusted key/i);
  });

  it('rejects a tampered release body', () => {
    const { signed, trusted } = makeSignedRelease();
    (signed as Record<string, unknown>).version = '9.9.9';
    const r = verifyReleaseSignature(signed as never, trusted);
    expect(r.verified).toBe(false);
  });
});

describe('verifyChecksum', () => {
  it('accepts a matching sha256 and rejects a mismatch', () => {
    const bytes = new Uint8Array(Buffer.from('hello', 'utf8'));
    const sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(verifyChecksum(bytes, 'sha256:' + sha).ok).toBe(true);
    expect(verifyChecksum(bytes, 'sha256:deadbeef').ok).toBe(false);
  });
});
