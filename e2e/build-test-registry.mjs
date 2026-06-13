// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Assemble a dev-signed, served-locally TEST registry from the four `:e2e`
 * images built by build-images.mjs. Two versions are emitted on the `test`
 * channel (`0.1.0` base + `0.1.1` next) so the e2e can drive a real
 * install-then-update against disposable images — never the public registry.
 *
 * Signing uses a deterministic dev Ed25519 key whose public half is written
 * into the served `keys/trusted-keys.json`, so the manager's real signature
 * verification runs end to end with no production secret.
 *
 * Usage (standalone):
 *   node e2e/build-test-registry.mjs --out <dir> [--owner <o>] [--tag <t>] [--base 0.1.0] [--next 0.1.1]
 */
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { imageTags, DEFAULT_OWNER, E2E_TAG } from './build-images.mjs';

export const E2E_KEY_ID = 'selfhelp-e2e';
const E2E_KEY_SEED = 'selfhelp-e2e-registry-signing-key';
const COMPAT_RANGE = '>=0.1.0 <0.2.0';

export function devKeyPair() {
  const seed = createHash('sha256').update(E2E_KEY_SEED).digest();
  return nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
}

/** Canonical JSON (sorted keys) — byte-identical to the registry/backend signer. */
export function canonicalStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
  }
  throw new Error(`Unsupported value: ${typeof value}`);
}

export function sign(body) {
  const kp = devKeyPair();
  const payload = canonicalStringify(body);
  const sig = nacl.sign.detached(new Uint8Array(Buffer.from(payload, 'utf8')), kp.secretKey);
  return {
    signature: Buffer.from(sig).toString('base64'),
    keyId: E2E_KEY_ID,
    signedPayloadSha256: `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`,
  };
}

function imageId(tag) {
  const out = execFileSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' });
  const id = out.trim();
  if (!id.startsWith('sha256:')) throw new Error(`unexpected image id for ${tag}: ${id}`);
  return id;
}

export function coreRelease(version, tags, digests) {
  return {
    kind: 'selfhelp-core-release',
    id: `selfhelp-core-${version}`,
    version,
    channel: 'test',
    releasedAt: '2026-06-09T00:00:00Z',
    minimumDirectUpgradeFrom: '0.1.0',
    pluginApiVersion: '0.1.0',
    backend: { image: tags.backend, digest: digests.backend, phpVersion: '8.4' },
    worker: { image: tags.worker, digest: digests.worker },
    scheduler: { image: tags.scheduler, digest: digests.scheduler },
    frontendCompatibility: { requiredFrontendRange: COMPAT_RANGE },
    database: { migrationRange: 'e2e', destructive: false, requiresBackup: true, manualConfirmationRequired: false },
    runtime: {
      php: { backendImagePhpVersion: '8.4' },
      mysql: { supportedVersions: '>=8.0 <9', recommendedVersion: '8.4', recommendedImage: 'mysql:8.4', majorUpgradeRequiresManualApproval: true },
      redis: { supportedVersions: '>=7 <8', recommendedImage: 'redis:7.2' },
      mercure: { supportedVersions: '>=0.14', recommendedImage: 'dunglas/mercure:v0.18' },
    },
  };
}

export function frontendRelease(version, tags, digest) {
  return {
    kind: 'selfhelp-frontend-release',
    id: `selfhelp-frontend-${version}`,
    version,
    channel: 'test',
    image: tags.frontend,
    digest,
    backendCompatibility: { requiredCoreRange: COMPAT_RANGE, requiredApiVersion: '0.1.0' },
  };
}

export function serviceRelease(kind, svc, version, image, digest) {
  return {
    kind,
    id: `selfhelp-${svc}-${version}`,
    version,
    channel: 'test',
    image,
    digest,
    backendCompatibility: { requiredCoreRange: COMPAT_RANGE },
  };
}

export function ref(svc, version) {
  return { id: `selfhelp-${svc}-${version}`, version, channel: 'test', releaseUrl: `releases/${svc}/selfhelp-${svc}-${version}.json` };
}

/** Identity of the dev-signed placeholder plugin published on the test channel. */
export const TEST_PLUGIN = { id: 'qa-e2e-noop', version: '0.1.0' };

/**
 * Unsigned plugin-release document for the test plugin (same unified shape the
 * production registry publishes and both the manager and the CMS verify).
 */
export function testPluginRelease(archiveSha256) {
  return {
    kind: 'selfhelp-plugin-release',
    id: TEST_PLUGIN.id,
    version: TEST_PLUGIN.version,
    channel: 'test',
    official: true,
    compatibility: { core: COMPAT_RANGE, pluginApi: '0.1.0' },
    artifacts: {
      manifestUrl: `releases/plugins/${TEST_PLUGIN.id}-${TEST_PLUGIN.version}.manifest.json`,
      archiveUrl: `releases/plugins/${TEST_PLUGIN.id}-${TEST_PLUGIN.version}.shplugin`,
      sha256: archiveSha256,
    },
  };
}

function writeJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Build the test registry into `outDir`. Returns the trusted-keys path + the
 * two versions. `baseUrl` is only the schema-required index field; the manager
 * fetches via the registryUrl passed to instanceInstall (the served URL).
 */
export function buildTestRegistry(opts) {
  const owner = opts.owner ?? DEFAULT_OWNER;
  const tag = opts.tag ?? E2E_TAG;
  const baseVersion = opts.base ?? '0.1.0';
  const nextVersion = opts.next ?? '0.1.1';
  const outDir = opts.out;
  if (!outDir) throw new Error('out dir is required.');
  const tags = imageTags(owner, tag);

  const digests = { backend: imageId(tags.backend), worker: imageId(tags.worker), scheduler: imageId(tags.scheduler) };
  const frontendDigest = imageId(tags.frontend);

  const versions = [baseVersion, nextVersion];
  for (const v of versions) {
    const core = coreRelease(v, tags, digests);
    writeJson(path.join(outDir, 'releases', 'core', `selfhelp-core-${v}.json`), { ...core, security: sign(core) });
    const fe = frontendRelease(v, tags, frontendDigest);
    writeJson(path.join(outDir, 'releases', 'frontend', `selfhelp-frontend-${v}.json`), { ...fe, security: sign(fe) });
    const sched = serviceRelease('selfhelp-scheduler-release', 'scheduler', v, tags.scheduler, digests.scheduler);
    writeJson(path.join(outDir, 'releases', 'scheduler', `selfhelp-scheduler-${v}.json`), { ...sched, security: sign(sched) });
    const worker = serviceRelease('selfhelp-worker-release', 'worker', v, tags.worker, digests.worker);
    writeJson(path.join(outDir, 'releases', 'worker', `selfhelp-worker-${v}.json`), { ...worker, security: sign(worker) });
  }

  // One minimal dev-signed TEST plugin release so `plugins` mirrors the real
  // registry shape (CMS catalogue / manager resolver surfaces see a non-empty
  // list whose signature verifies against the SAME e2e key). The archive is a
  // small placeholder with a correct sha256 — release-level verification is
  // what this exercises; the full install pipeline stays covered by the
  // backend's own suite + the manager's plugin-state unit tests.
  const pluginId = TEST_PLUGIN.id;
  const pluginVersion = TEST_PLUGIN.version;
  writeJson(path.join(outDir, 'releases', 'plugins', `${pluginId}-${pluginVersion}.manifest.json`), {
    id: pluginId,
    name: 'QA E2E No-op Plugin',
    description: 'Placeholder plugin for manager e2e registry verification. Never installable.',
    version: pluginVersion,
    pluginApiVersion: '0.1.0',
    license: 'MPL-2.0',
    compatibility: { selfhelp: COMPAT_RANGE, php: '^8.4' },
  });
  const archiveBytes = Buffer.from(`qa-e2e-noop placeholder archive ${pluginVersion}\n`, 'utf8');
  const pluginRelease = testPluginRelease(`sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`);
  const archiveAbs = path.join(outDir, pluginRelease.artifacts.archiveUrl);
  mkdirSync(path.dirname(archiveAbs), { recursive: true });
  writeFileSync(archiveAbs, archiveBytes);
  writeJson(path.join(outDir, 'releases', 'plugins', `${pluginId}-${pluginVersion}.json`), {
    ...pluginRelease,
    security: sign(pluginRelease),
  });

  const registry = {
    schemaVersion: '1.0',
    requiresManager: '>=0.1.0 <2.0.0',
    publishedAt: '2026-06-09T00:00:00Z',
    baseUrl: opts.baseUrl ?? 'http://127.0.0.1/',
    publisher: { name: 'selfhelp-e2e', url: 'http://127.0.0.1' },
    trustedKeysUrl: 'keys/trusted-keys.json',
    core: versions.map((v) => ref('core', v)),
    frontend: versions.map((v) => ref('frontend', v)),
    scheduler: versions.map((v) => ref('scheduler', v)),
    worker: versions.map((v) => ref('worker', v)),
    plugins: [
      { id: pluginId, version: pluginVersion, channel: 'test', releaseUrl: `releases/plugins/${pluginId}-${pluginVersion}.json` },
    ],
  };
  writeJson(path.join(outDir, 'registry.json'), registry);

  const kp = devKeyPair();
  const trustedKeysPath = path.join(outDir, 'keys', 'trusted-keys.json');
  writeJson(trustedKeysPath, {
    schemaVersion: '1.0',
    keys: [{ keyId: E2E_KEY_ID, publicKey: Buffer.from(kp.publicKey).toString('base64'), algorithm: 'ed25519', status: 'active' }],
  });

  return { dir: outDir, trustedKeysPath, base: baseVersion, next: nextVersion, pluginId, pluginVersion };
}

function parseFlags(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const k = tok.slice(2);
      const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const a = parseFlags(process.argv.slice(2));
    if (typeof a.out !== 'string') throw new Error('--out <dir> is required.');
    const result = buildTestRegistry({
      out: a.out,
      ...(typeof a.owner === 'string' ? { owner: a.owner } : {}),
      ...(typeof a.tag === 'string' ? { tag: a.tag } : {}),
      ...(typeof a.base === 'string' ? { base: a.base } : {}),
      ...(typeof a.next === 'string' ? { next: a.next } : {}),
      ...(typeof a.baseUrl === 'string' ? { baseUrl: a.baseUrl } : {}),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`build-test-registry.mjs: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
