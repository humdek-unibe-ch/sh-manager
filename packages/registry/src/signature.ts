// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Ed25519 signature verification for signed registry release payloads.
 *
 * Production must never install unsigned releases, releases with unknown
 * checksums, or releases signed by untrusted/revoked keys. Development mode
 * (explicit opt-in) may relax this, but the relaxation is the caller's
 * decision — this module only reports verification facts.
 */
import nacl from 'tweetnacl';
import type { SignatureBlock, TrustedKey, TrustedKeysFile } from '@shm/schemas';
import { canonicalize, normalizeSha256, sha256Hex } from './canonical.js';

export interface VerificationResult {
  verified: boolean;
  reason?: string;
  keyId?: string;
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/** Verifies a raw Ed25519 detached signature over a UTF-8 payload. */
export function verifyEd25519(
  payload: string,
  signatureBase64: string,
  publicKeyBase64: string,
): boolean {
  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    sig = fromBase64(signatureBase64);
    pub = fromBase64(publicKeyBase64);
  } catch {
    return false;
  }
  if (sig.length !== nacl.sign.signatureLength || pub.length !== nacl.sign.publicKeyLength) {
    return false;
  }
  const message = new Uint8Array(Buffer.from(payload, 'utf8'));
  try {
    return nacl.sign.detached.verify(message, sig, pub);
  } catch {
    return false;
  }
}

export function findActiveKey(keys: TrustedKeysFile, keyId: string): TrustedKey | undefined {
  return keys.keys.find((k) => k.keyId === keyId && k.status === 'active');
}

/**
 * Verifies a signed release block against the trusted key set.
 *
 * The signed payload is `security.signedPayload` when present (the exact bytes
 * CI signed). Otherwise the canonical form of `entry` without its `security`
 * block is used. When `signedPayloadSha256` is present it must match.
 */
export function verifyReleaseSignature(
  entry: { security: SignatureBlock } & Record<string, unknown>,
  trustedKeys: TrustedKeysFile,
): VerificationResult {
  const security = entry.security;
  if (!security || typeof security.signature !== 'string' || security.signature === '') {
    return { verified: false, reason: 'Release is unsigned (missing signature).' };
  }
  if (typeof security.keyId !== 'string' || security.keyId === '' || security.keyId === 'dev') {
    return {
      verified: false,
      reason: `Release keyId "${security.keyId ?? ''}" is not acceptable in production.`,
      keyId: security.keyId,
    };
  }
  const key = findActiveKey(trustedKeys, security.keyId);
  if (!key) {
    return {
      verified: false,
      reason: `No active trusted key for keyId "${security.keyId}".`,
      keyId: security.keyId,
    };
  }

  let payload: string;
  if (typeof security.signedPayload === 'string' && security.signedPayload !== '') {
    payload = security.signedPayload;
  } else {
    const clone: Record<string, unknown> = { ...entry };
    delete clone.security;
    payload = canonicalize(clone);
  }

  if (
    typeof security.signedPayloadSha256 === 'string' &&
    security.signedPayloadSha256 !== '' &&
    normalizeSha256(security.signedPayloadSha256) !== sha256Hex(payload)
  ) {
    return {
      verified: false,
      reason: 'signedPayloadSha256 does not match the canonical payload.',
      keyId: security.keyId,
    };
  }

  const ok = verifyEd25519(payload, security.signature, key.publicKey);
  return ok
    ? { verified: true, keyId: security.keyId }
    : { verified: false, reason: 'Ed25519 signature verification failed.', keyId: security.keyId };
}
