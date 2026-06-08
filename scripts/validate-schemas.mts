// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Validates every committed example fixture against its JSON Schema and verifies
 * the signed core/frontend releases against the trusted keys. This is the
 * `npm run validate:schemas` gate: schema drift or a broken signature fails CI.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseSignature } from '@shm/registry';
import {
  validateBackupManifest,
  validateCoreRelease,
  validateFrontendRelease,
  validateInstanceLock,
  validateInstanceManifest,
  validateRegistryIndex,
  validateServerInventory,
  validateTrustedKeys,
  validateUpdatePreflight,
  type TrustedKeysFile,
  type ValidationResult,
} from '@shm/schemas';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.join(here, '..', 'packages', 'schemas', 'examples');

const fileSchemas: Record<string, (d: unknown) => ValidationResult<unknown>> = {
  'server-inventory.json': validateServerInventory,
  'instance-manifest.json': validateInstanceManifest,
  'instance-lock.json': validateInstanceLock,
  'registry-index.json': validateRegistryIndex,
  'core-release.json': validateCoreRelease,
  'frontend-release.json': validateFrontendRelease,
  'update-preflight.json': validateUpdatePreflight,
  'backup-manifest.json': validateBackupManifest,
  'trusted-keys.json': validateTrustedKeys,
};

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(examplesDir, name), 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const errors: string[] = [];

  for (const [name, validate] of Object.entries(fileSchemas)) {
    let data: unknown;
    try {
      data = await readJson(name);
    } catch (err) {
      errors.push(`${name}: cannot read (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const result = validate(data);
    if (!result.valid) {
      errors.push(`${name}: ${result.errors.join('; ')}`);
    } else {
      console.log(`schema ok   ${name}`);
    }
  }

  // Signature verification for signed releases against the trusted key set.
  try {
    const trusted = (await readJson('trusted-keys.json')) as TrustedKeysFile;
    for (const releaseName of ['core-release.json', 'frontend-release.json']) {
      const release = (await readJson(releaseName)) as { security: { signature: string; keyId: string } } & Record<string, unknown>;
      const v = verifyReleaseSignature(release, trusted);
      if (!v.verified) {
        errors.push(`${releaseName}: signature verification failed (${v.reason})`);
      } else {
        console.log(`signature ok ${releaseName} (${v.keyId})`);
      }
    }
  } catch (err) {
    errors.push(`signature check: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (errors.length > 0) {
    console.error('\nSchema/signature validation FAILED:');
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }
  console.log('\nAll example fixtures validate and verify.');
}

await main();
