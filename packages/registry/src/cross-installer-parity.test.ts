// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Cross-installer SAME-FIXTURE parity — manager half.
 *
 * The unified-registry contract promises ONE signed release document is
 * verifiable by BOTH installers. The backend proves its half against the
 * manager's committed example (see the backend's
 * `CrossInstallerManagerFixtureParityTest`); this test closes the loop by
 * verifying release documents the OTHER installer authored + signed: the
 * CMS/backend fixtures under
 * `sh-selfhelp_backend/tests/fixtures/registry/unified/releases/`.
 *
 * Those backend documents ship an inline `security.signedPayload`. To make this
 * a genuine canonical-parity proof (not "verify the bytes the doc already
 * carries"), we STRIP the inline payload before verifying, forcing the manager
 * to recompute the canonical JSON form. A passing verification + matching
 * `signedPayloadSha256` therefore proves the manager `canonicalize` is
 * byte-identical to the backend `SignedPayloadBuilder`/`CanonicalJson` that
 * produced the signature.
 *
 * Skipped automatically when the sibling backend repo is not checked out (CI
 * isolation); runs in the dev workspace layout.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TrustedKeysFile } from '@shm/schemas';
import { canonicalize, normalizeSha256, sha256Hex } from './canonical.js';
import { verifyReleaseSignature } from './signature.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoParent = path.resolve(here, '../../../..');
const backendReleases = path.join(repoParent, 'sh-selfhelp_backend', 'tests', 'fixtures', 'registry', 'unified', 'releases');
const trustedKeysPath = path.join(here, '..', '..', 'schemas', 'examples', 'trusted-keys.json');

interface SignedDoc {
  security: {
    signature: string;
    keyId: string;
    signedPayload?: string;
    signedPayloadSha256?: string;
  } & Record<string, unknown>;
  [key: string]: unknown;
}

function loadTrustedKeys(): TrustedKeysFile {
  return JSON.parse(readFileSync(trustedKeysPath, 'utf8')) as TrustedKeysFile;
}

/** Read a backend fixture and drop its inline payload to force a recompute. */
function loadBackendDocStrippingInlinePayload(relPath: string): SignedDoc {
  const doc = JSON.parse(readFileSync(path.join(backendReleases, relPath), 'utf8')) as SignedDoc;
  expect(typeof doc.security.signedPayload).toBe('string'); // backend ships it inline
  delete doc.security.signedPayload; // ...we strip it so the manager must recompute
  return doc;
}

describe('cross-installer same-fixture parity (manager verifies backend-authored releases)', () => {
  const cases = [
    { label: 'core release', rel: path.join('core', 'selfhelp-core-0.1.0.json') },
    { label: 'plugin release', rel: path.join('plugins', 'sh2-shp-survey-js-0.1.0.json') },
  ];

  for (const { label, rel } of cases) {
    it.runIf(existsSync(backendReleases))(`recomputes canonical bytes + verifies the backend-signed ${label}`, () => {
      const trustedKeys = loadTrustedKeys();
      const doc = loadBackendDocStrippingInlinePayload(rel);

      // (1) Direct canonical-byte parity: the manager canonicalize() over the
      //     security-stripped backend document reproduces the EXACT hash the
      //     backend signer recorded in security.signedPayloadSha256.
      const clone: Record<string, unknown> = { ...doc };
      delete clone.security;
      const expectedHash = normalizeSha256(String(doc.security.signedPayloadSha256));
      expect(sha256Hex(canonicalize(clone))).toBe(expectedHash);

      // (2) Full verifier path: the recomputed canonical bytes verify against the
      //     shared dev key, exactly as a production verify would.
      const result = verifyReleaseSignature(doc, trustedKeys);
      expect(result.verified).toBe(true);
      expect(result.keyId).toBe('selfhelp-official-2026');
    });
  }
});
