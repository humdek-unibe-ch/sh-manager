// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Generates the committed example fixtures under packages/schemas/examples/.
 *
 * Core + frontend releases are really signed with a DETERMINISTIC DEV Ed25519
 * key (derived from a fixed seed) so the registry signature/checksum tests run
 * end-to-end offline. This dev key is NOT a production signing key; production
 * keys live in CI secrets and are published (public half only) to the registry
 * trusted-keys file.
 *
 * Run: npm run fixtures:sign
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { canonicalize, sha256Hex } from '@shm/registry';
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
  type ValidationResult,
} from '@shm/schemas';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.join(here, '..', 'packages', 'schemas', 'examples');

const DEV_KEY_ID = 'selfhelp-official-2026';
const seed = createHash('sha256').update('selfhelp-dev-registry-signing-key-v1').digest();
const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
const publicKeyB64 = Buffer.from(keyPair.publicKey).toString('base64');

function sign(releaseWithoutSecurity: Record<string, unknown>): {
  signature: string;
  keyId: string;
  signedPayloadSha256: string;
} {
  const payload = canonicalize(releaseWithoutSecurity);
  const sig = nacl.sign.detached(new Uint8Array(Buffer.from(payload, 'utf8')), keyPair.secretKey);
  return {
    signature: Buffer.from(sig).toString('base64'),
    keyId: DEV_KEY_ID,
    signedPayloadSha256: `sha256:${sha256Hex(payload)}`,
  };
}

const coreNoSec = {
  kind: 'selfhelp-core-release',
  id: 'selfhelp-core-1.5.0',
  version: '1.5.0',
  channel: 'stable',
  releasedAt: '2026-06-01T00:00:00Z',
  minimumDirectUpgradeFrom: '1.0.0',
  pluginApiVersion: '2.1',
  backend: { image: 'ghcr.io/humdek-unibe-ch/selfhelp-backend:1.5.0', digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111', phpVersion: '8.4' },
  worker: { image: 'ghcr.io/humdek-unibe-ch/selfhelp-worker:1.5.0', digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222' },
  scheduler: { image: 'ghcr.io/humdek-unibe-ch/selfhelp-scheduler:1.5.0', digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' },
  frontendCompatibility: { requiredFrontendRange: '>=1.5.0 <1.6.0' },
  database: { migrationRange: 'Version20260501000000..Version20260605081254', destructive: false, requiresBackup: true, manualConfirmationRequired: false },
};
const coreRelease = { ...coreNoSec, security: sign(coreNoSec) };

const frontendNoSec = {
  kind: 'selfhelp-frontend-release',
  id: 'selfhelp-frontend-1.5.0',
  version: '1.5.0',
  channel: 'stable',
  image: 'ghcr.io/humdek-unibe-ch/selfhelp-frontend:1.5.0',
  digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  builtFrom: { nextStandalone: true, sharedPackageVersion: '1.5.0' },
  backendCompatibility: { requiredCoreRange: '>=1.5.0 <1.6.0', requiredApiVersion: '2.1' },
};
const frontendRelease = { ...frontendNoSec, security: sign(frontendNoSec) };

const registryIndex = {
  schemaVersion: '1.0',
  requiresManager: '>=0.1.0',
  publishedAt: '2026-06-05T12:00:00Z',
  baseUrl: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/',
  publisher: { name: 'SelfHelp (University of Bern)', url: 'https://www.unibe.ch/' },
  core: [{ id: 'selfhelp-core-1.5.0', version: '1.5.0', channel: 'stable', releaseUrl: 'releases/core/selfhelp-core-1.5.0.json' }],
  frontend: [{ id: 'selfhelp-frontend-1.5.0', version: '1.5.0', channel: 'stable', releaseUrl: 'releases/frontend/selfhelp-frontend-1.5.0.json' }],
  scheduler: [],
  worker: [],
  plugins: [],
};

const trustedKeys = {
  schemaVersion: '1.0',
  keys: [{ keyId: DEV_KEY_ID, publicKey: publicKeyB64, algorithm: 'ed25519', status: 'active' }],
};

const serverInventory = {
  inventoryVersion: 1,
  serverId: 'selfhelp-server-001',
  manager: { name: 'SelfHelp Manager', repository: 'sh-manager', version: '0.1.0' },
  proxy: { type: 'traefik', network: 'selfhelp_proxy', composePath: '/opt/selfhelp/proxy/compose.yaml' },
  instances: [
    { instanceId: 'website1', domain: 'website1.example.ch', path: '/opt/selfhelp/instances/website1', composeProject: 'selfhelp_website1', status: 'active' },
  ],
};

const instanceManifest = {
  manifestVersion: 1,
  instanceId: 'website1',
  displayName: 'Website 1 Study',
  domain: 'website1.example.ch',
  mode: 'production',
  createdAt: '2026-06-05T10:00:00+00:00',
  updatedAt: '2026-06-05T10:00:00+00:00',
  registry: { id: 'selfhelp-official', url: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/', channel: 'stable' },
  versions: { selfhelp: '1.5.0', backend: '1.5.0', frontend: '1.5.0', scheduler: '1.5.0', worker: '1.5.0', pluginApi: '2.1' },
  images: {
    backend: coreNoSec.backend.image, frontend: frontendNoSec.image, scheduler: coreNoSec.scheduler.image,
    worker: coreNoSec.worker.image, mysql: 'mysql:8.4', redis: 'redis:7.2', mercure: 'dunglas/mercure:0.18',
  },
  routing: { publicFrontendUrl: 'https://website1.example.ch', browserApiPrefix: '/api', internalSymfonyUrl: 'http://backend:8080', symfonyApiPrefix: '/cms-api/v1' },
  installedPlugins: [{ id: 'survey-js', version: '1.3.0' }],
};

const instanceLock = {
  lockfileVersion: 1,
  generatedAt: '2026-06-05T10:00:00+00:00',
  registry: { id: 'selfhelp-official', url: 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/', metadataSha256: `sha256:${sha256Hex(canonicalize(registryIndex))}` },
  core: {
    version: '1.5.0',
    backendImageDigest: coreNoSec.backend.digest,
    frontendImageDigest: frontendNoSec.digest,
    schedulerImageDigest: coreNoSec.scheduler.digest,
    workerImageDigest: coreNoSec.worker.digest,
    migrationVersion: 'Version20260605081254',
    pluginApiVersion: '2.1',
    signedPayloadSha256: coreRelease.security.signedPayloadSha256,
  },
  services: {
    mysql: { image: 'mysql:8.4', digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555' },
    redis: { image: 'redis:7.2', digest: 'sha256:6666666666666666666666666666666666666666666666666666666666666666' },
    mercure: { image: 'dunglas/mercure:0.18', digest: 'sha256:7777777777777777777777777777777777777777777777777777777777777777' },
  },
  plugins: {
    'survey-js': {
      version: '1.3.0', artifactSha256: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
      signature: 'ZGV2LXNpZ25hdHVyZQ==', keyId: DEV_KEY_ID, compatibility: { core: '>=1.0.0 <1.6.0', pluginApi: '>=2.0' },
    },
  },
};

const updatePreflight = {
  preflightVersion: 1,
  status: 'warning',
  instanceId: 'website1',
  currentVersion: '1.4.2',
  targetVersion: '1.5.0',
  checks: [
    { code: 'docker.available', severity: 'info', message: 'Docker engine is available.' },
    { code: 'database.destructive', severity: 'warning', message: 'Target includes a destructive migration; backup + confirmation required.' },
  ],
  options: [{ type: 'update_plugin', version: '1.4.0', label: 'Update survey-js to 1.4.0 first' }],
  database: { destructive: true, requiresBackup: true, manualConfirmationRequired: true },
  rollback: { automaticBeforeMigrations: true, automaticAfterDestructiveMigrations: true },
};

const backupManifest = {
  backupManifestVersion: 1,
  backupId: 'backup-20260605-website1-001',
  instanceId: 'website1',
  createdAt: '2026-06-05T09:00:00Z',
  mode: 'maintenance',
  selfhelpVersion: '1.4.2',
  migrationVersion: 'Version20260605081254',
  plugins: [{ id: 'survey-js', version: '1.3.0' }],
  includedAreas: ['database', 'uploads', 'plugin_artifacts', 'manifest', 'lock'],
  files: [
    { path: 'database.sql.gz', sha256: 'sha256:9999999999999999999999999999999999999999999999999999999999999999', bytes: 10485760 },
    { path: 'uploads.tar.gz', sha256: 'sha256:aaaa999999999999999999999999999999999999999999999999999999999999', bytes: 2097152 },
  ],
};

const files: { name: string; data: unknown; validate: (d: unknown) => ValidationResult<unknown> }[] = [
  { name: 'server-inventory.json', data: serverInventory, validate: validateServerInventory },
  { name: 'instance-manifest.json', data: instanceManifest, validate: validateInstanceManifest },
  { name: 'instance-lock.json', data: instanceLock, validate: validateInstanceLock },
  { name: 'registry-index.json', data: registryIndex, validate: validateRegistryIndex },
  { name: 'core-release.json', data: coreRelease, validate: validateCoreRelease },
  { name: 'frontend-release.json', data: frontendRelease, validate: validateFrontendRelease },
  { name: 'update-preflight.json', data: updatePreflight, validate: validateUpdatePreflight },
  { name: 'backup-manifest.json', data: backupManifest, validate: validateBackupManifest },
  { name: 'trusted-keys.json', data: trustedKeys, validate: validateTrustedKeys },
];

async function main(): Promise<void> {
  await mkdir(examplesDir, { recursive: true });
  let failed = false;
  for (const f of files) {
    const result = f.validate(f.data);
    if (!result.valid) {
      failed = true;
      console.error(`FIXTURE INVALID ${f.name}: ${result.errors.join('; ')}`);
      continue;
    }
    await writeFile(path.join(examplesDir, f.name), JSON.stringify(f.data, null, 2) + '\n', 'utf8');
    console.log(`wrote ${f.name}`);
  }
  if (failed) process.exit(1);
  console.log(`\nDev signing public key (${DEV_KEY_ID}): ${publicKeyB64}`);
}

await main();
