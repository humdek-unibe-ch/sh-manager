// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { normalizeSha256, sha256Hex } from './canonical.js';

export interface ChecksumResult {
  ok: boolean;
  expected: string;
  actual: string;
  reason?: string;
}

/** Verifies artifact bytes against an expected `sha256:<hex>`/`<hex>` digest. */
export function verifyChecksum(bytes: Uint8Array, expectedSha256: string): ChecksumResult {
  const expected = normalizeSha256(expectedSha256);
  const actual = sha256Hex(bytes);
  if (!expected) {
    return { ok: false, expected, actual, reason: 'Missing expected checksum.' };
  }
  if (expected !== actual) {
    return { ok: false, expected, actual, reason: 'Checksum mismatch.' };
  }
  return { ok: true, expected, actual };
}
