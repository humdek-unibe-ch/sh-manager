// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Release smoke suite (plan §10 "Release smoke-test CI").
 *
 * Exercises the three release-critical journeys end to end against the SIGNED
 * fixture registry, the real install/update/health/compose-generation code
 * paths, a RecordingComposeRunner, and DI'd OS-boundary helpers — so it runs
 * fully offline in CI (`npm run smoke`) without pulling images or touching a
 * real Docker daemon:
 *
 *   1. Fresh install (local mode) brings the stack up and reports healthy.
 *   2. Update-from-previous (0.1.0 -> 0.2.0) takes a real backup, runs the
 *      maintenance window, migrates, health-checks, and lands the new version
 *      without ever tearing the MySQL data volume down.
 *   3. Two-instance routing isolation: each instance is its own compose project
 *      with private networks/volumes, and ONLY the shared proxy network is
 *      common — the data plane is never shared.
 *
 * The 0.2.0 upgrade target is minted in-memory and signed with the SAME
 * deterministic dev key the committed fixtures use (`scripts/sign-fixtures.mts`),
 * so the registry-client signature verification runs for real.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import nacl from 'tweetnacl';
import type { TrustedKeysFile } from '@shm/schemas';
import { RecordingComposeRunner, type ComposeResult } from '@shm/docker';
import { canonicalize, sha256Hex, type Fetcher, type FetchResponse } from '@shm/registry';
import { LockStore, ManifestStore, instancePaths } from '@shm/instances';
import type { ActionDeps } from './actions.js';
import { instanceHealth, instanceInstall, instanceUpdate, serverInit } from './actions.js';

const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'schemas', 'examples');
const readExample = (n: string) => readFile(path.join(examplesDir, n), 'utf8');

const DEV_KEY_ID = 'selfhelp-official-2026';
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

/**
 * Build a registry that offers BOTH 0.1.0 (committed, already signed) and a
 * freshly minted, dev-signed 0.2.0 upgrade target for core + frontend.
 */
async function buildUpgradeRegistry(): Promise<Record<string, string>> {
  const core010 = await readExample('core-release.json');
  const frontend010 = await readExample('frontend-release.json');

  const { security: _coreSec, ...core020Body } = JSON.parse(core010) as Record<string, unknown> & { security?: unknown };
  core020Body.id = 'selfhelp-core-0.2.0';
  core020Body.version = '0.2.0';
  core020Body.minimumDirectUpgradeFrom = '0.1.0';
  core020Body.backend = { image: 'ghcr.io/humdek-unibe-ch/selfhelp-backend:0.2.0', digest: `sha256:${'1'.repeat(64)}`, phpVersion: '8.4' };
  core020Body.worker = { image: 'ghcr.io/humdek-unibe-ch/selfhelp-worker:0.2.0', digest: `sha256:${'2'.repeat(64)}` };
  core020Body.scheduler = { image: 'ghcr.io/humdek-unibe-ch/selfhelp-scheduler:0.2.0', digest: `sha256:${'3'.repeat(64)}` };
  core020Body.frontendCompatibility = { requiredFrontendRange: '>=0.2.0 <0.3.0' };
  // A clean, non-destructive minor so the smoke update needs no risk acceptance.
  core020Body.database = { migrationRange: 'Version20260605081254..Version20260606090000', destructive: false, requiresBackup: true, manualConfirmationRequired: false };
  const core020 = JSON.stringify({ ...core020Body, security: sign(core020Body) });

  const { security: _feSec, ...fe020Body } = JSON.parse(frontend010) as Record<string, unknown> & { security?: unknown };
  fe020Body.id = 'selfhelp-frontend-0.2.0';
  fe020Body.version = '0.2.0';
  fe020Body.image = 'ghcr.io/humdek-unibe-ch/selfhelp-frontend:0.2.0';
  fe020Body.backendCompatibility = { requiredCoreRange: '>=0.2.0 <0.3.0', requiredApiVersion: '0.1.0' };
  const fe020 = JSON.stringify({ ...fe020Body, security: sign(fe020Body) });

  const index = JSON.parse(await readExample('registry-index.json')) as {
    core: unknown[];
    frontend: unknown[];
  };
  index.core.push({ id: 'selfhelp-core-0.2.0', version: '0.2.0', channel: 'stable', releaseUrl: 'releases/core/selfhelp-core-0.2.0.json' });
  index.frontend.push({ id: 'selfhelp-frontend-0.2.0', version: '0.2.0', channel: 'stable', releaseUrl: 'releases/frontend/selfhelp-frontend-0.2.0.json' });

  return {
    'registry.json': JSON.stringify(index),
    'selfhelp-core-0.1.0.json': core010,
    'selfhelp-core-0.2.0.json': core020,
    'selfhelp-frontend-0.1.0.json': frontend010,
    'selfhelp-frontend-0.2.0.json': fe020,
  };
}

const REGISTRY_URL = 'https://humdek-unibe-ch.github.io/sh2-plugin-registry/';

let root: string;
let trustedKeys: TrustedKeysFile;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-smoke-'));
  trustedKeys = JSON.parse(await readExample('trusted-keys.json')) as TrustedKeysFile;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Deps that drive the real action functions: a recording runner that answers
 * `mysqldump` (so the in-update backup works), DI'd volume/db helpers, an
 * always-healthy probe, and the signed two-version upgrade registry.
 */
async function smokeDeps(): Promise<{ d: ActionDeps; runner: RecordingComposeRunner }> {
  const fetcher = new FixtureFetcher(await buildUpgradeRegistry());
  const digest = `sha256:${'a'.repeat(64)}`;
  const runner = new RecordingComposeRunner((args: string[]): ComposeResult =>
    args.join(' ').includes('mysqldump') ? { stdout: '-- dump\n', stderr: '' } : { stdout: '', stderr: '' },
  );
  const d: ActionDeps = {
    root,
    managerVersion: '0.1.0',
    trustedKeys,
    runner,
    fetcher,
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
    archiveVolume: async (_volumeName, outFile) => {
      await writeFile(outFile, 'archive-bytes');
    },
    removeVolumes: async () => {},
    extractVolume: async () => {},
    copyVolume: async () => {},
    importDatabase: async () => {},
  };
  return { d, runner };
}

interface SmokeService {
  networks?: string[];
}
interface SmokeNetwork {
  external?: boolean;
  name?: string;
}
interface SmokeVolume {
  name?: string;
}
interface SmokeCompose {
  name: string;
  services: Record<string, SmokeService | undefined> & { frontend: SmokeService };
  networks: Record<string, SmokeNetwork | undefined> & { selfhelp_proxy: SmokeNetwork; instance: SmokeNetwork };
  volumes: Record<string, SmokeVolume | undefined> & { mysql_data: SmokeVolume };
}

async function readCompose(instanceId: string): Promise<SmokeCompose> {
  const text = await readFile(instancePaths(instanceId, root).composePath, 'utf8');
  return parseYaml(text) as SmokeCompose;
}

describe('release smoke (offline, signed fixture registry)', () => {
  it('fresh install (local mode) brings the stack up and reports healthy', async () => {
    const { d, runner } = await smokeDeps();
    await serverInit(d, { serverId: 'srv-smoke', mode: 'production', letsencryptEmail: 'ops@example.ch' });

    const res = await instanceInstall(d, {
      instanceId: 'qa-fresh',
      displayName: 'QA Fresh',
      mode: 'local',
      localPort: 8080,
      registryUrl: REGISTRY_URL,
      version: '0.1.0',
      bringUp: true,
    });

    expect(res.version).toBe('0.1.0');
    expect(res.broughtUp).toBe(true);
    expect(runner.calls.map((c) => c.args.join(' '))).toContain('up -d');

    const manifest = await new ManifestStore('qa-fresh', root).read();
    expect(manifest.versions.selfhelp).toBe('0.1.0');

    const health = await instanceHealth(d, 'qa-fresh');
    expect(health.overall).toBe('healthy');
  });

  it('update-from-previous (0.1.0 -> 0.2.0) backs up, runs maintenance, migrates, and preserves the MySQL volume', async () => {
    const { d, runner } = await smokeDeps();
    await serverInit(d, { serverId: 'srv-smoke', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(d, {
      instanceId: 'qa-upd',
      displayName: 'QA Update',
      mode: 'production',
      domain: 'qa-upd.example.ch',
      registryUrl: REGISTRY_URL,
      version: '0.1.0',
      bringUp: true,
    });

    const { plan, executed, report } = await instanceUpdate(d, 'qa-upd', { target: 'latest' });
    expect(plan.targetVersion).toBe('0.2.0');
    expect(executed).toBe(true);
    expect(report?.ok).toBe(true);
    expect(report?.requiresManualRestore).toBeFalsy();

    const manifest = await new ManifestStore('qa-upd', root).read();
    const lock = await new LockStore('qa-upd', root).read();
    expect(manifest.versions.selfhelp).toBe('0.2.0');
    expect(lock.core.version).toBe('0.2.0');

    const dir = instancePaths('qa-upd', root).dir;
    const joined = runner.calls.filter((c) => c.cwd === dir).map((c) => c.args.join(' '));
    expect(joined.some((a) => a.includes('selfhelp:maintenance --enable'))).toBe(true);
    expect(joined.some((a) => a.includes('selfhelp:maintenance --disable'))).toBe(true);
    expect(joined.some((a) => a.includes('doctrine:migrations:migrate'))).toBe(true);
    expect(joined).toContain('up -d');
    // The maintenance window stops the traffic producers...
    expect(runner.calls.some((c) => c.cwd === dir && c.args[0] === 'stop' && c.args.includes('frontend'))).toBe(true);
    // ...but the MySQL data volume is NEVER torn down during an update.
    expect(joined.some((a) => a.includes('-v') || a.includes('--volumes'))).toBe(false);
  });

  it('an in-place update is not blocked when host ports 80/443 are already bound', async () => {
    // Regression: an update reuses the running instance's already-bound ports
    // (Traefik's 80/443 in production, or the local published port), so it must
    // NOT require them to be free. Here the host reports 80/443 busy (e.g.
    // Traefik or another service holds them); the update must still execute.
    const { d } = await smokeDeps();
    const deps: ActionDeps = {
      ...d,
      resourceFacts: async (ports) => ({
        requiredPortsFree: ports.map((p) => ({ port: p, free: p !== 80 && p !== 443 })),
        diskBytesFree: 100 * 1024 * 1024 * 1024,
        memoryBytesTotal: 16 * 1024 * 1024 * 1024,
        cpuCount: 8,
        dockerAvailable: true,
        dockerComposeAvailable: true,
      }),
    };
    await serverInit(deps, { serverId: 'srv-smoke', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(deps, {
      instanceId: 'qa-ports',
      displayName: 'QA Ports',
      mode: 'production',
      domain: 'qa-ports.example.ch',
      registryUrl: REGISTRY_URL,
      version: '0.1.0',
      bringUp: true,
    });

    const { plan, executed } = await instanceUpdate(deps, 'qa-ports', { target: 'latest' });
    expect(plan.status).not.toBe('blocked');
    expect(executed).toBe(true);
  });

  it('a local-mode update rebuilds the compose with the pinned localPort', async () => {
    // Regression: an update rebuilds the instance artifacts from the manifest. A
    // LOCAL instance pins a published `localPort` (not a domain); if the update
    // does not recover it, `buildInstanceInstallArtifacts` aborts with "Local
    // install requires a localPort." and the update fails at the `update` step
    // (executed: true, but report.ok: false). The existing update smoke uses
    // production mode, so it never exercised this path.
    const { d } = await smokeDeps();
    await serverInit(d, { serverId: 'srv-smoke', mode: 'production', letsencryptEmail: 'ops@example.ch' });
    await instanceInstall(d, {
      instanceId: 'qa-local-upd',
      displayName: 'QA Local Update',
      mode: 'local',
      localPort: 8088,
      registryUrl: REGISTRY_URL,
      version: '0.1.0',
      bringUp: true,
    });

    const { plan, executed, report } = await instanceUpdate(d, 'qa-local-upd', { target: 'latest' });
    expect(plan.targetVersion).toBe('0.2.0');
    expect(executed).toBe(true);
    expect(report?.ok).toBe(true);
    expect(report?.rolledBack).toBeFalsy();
    // The rebuilt compose still publishes the original local port.
    const compose = await readCompose('qa-local-upd');
    const frontendPorts = (compose.services.frontend as { ports?: string[] }).ports ?? [];
    expect(frontendPorts.some((p) => p.includes('8088'))).toBe(true);
    const manifest = await new ManifestStore('qa-local-upd', root).read();
    expect(manifest.versions.selfhelp).toBe('0.2.0');
  });

  it('two-instance routing isolation: only the shared proxy network is common', async () => {
    const { d } = await smokeDeps();
    await serverInit(d, { serverId: 'srv-smoke', mode: 'production', letsencryptEmail: 'ops@example.ch' });

    for (const [id, domain] of [['qa-one', 'qa-one.example.ch'], ['qa-two', 'qa-two.example.ch']] as const) {
      await instanceInstall(d, {
        instanceId: id,
        displayName: id,
        mode: 'production',
        domain,
        registryUrl: REGISTRY_URL,
        version: 'latest',
        bringUp: true,
      });
    }

    const one = await readCompose('qa-one');
    const two = await readCompose('qa-two');

    // Distinct compose projects.
    expect(one.name).toBe('selfhelp_qa-one');
    expect(two.name).toBe('selfhelp_qa-two');
    expect(one.name).not.toBe(two.name);

    // Only the frontend touches the shared proxy network; the data plane stays private.
    for (const c of [one, two]) {
      expect(c.services.frontend.networks).toEqual(expect.arrayContaining(['instance', 'selfhelp_proxy']));
      for (const svc of ['backend', 'worker', 'scheduler', 'mysql', 'redis', 'mercure']) {
        expect(c.services[svc]?.networks).toEqual(['instance']);
      }
    }

    // The proxy network is external + shared (same name); the private instance
    // network and every volume are per-project, so nothing else is shared.
    expect(one.networks.selfhelp_proxy.external).toBe(true);
    expect(two.networks.selfhelp_proxy.external).toBe(true);
    expect(one.networks.selfhelp_proxy.name).toBe(two.networks.selfhelp_proxy.name);
    expect(one.networks.instance.name).toBe('selfhelp_qa-one_instance');
    expect(two.networks.instance.name).toBe('selfhelp_qa-two_instance');
    expect(one.networks.instance.name).not.toBe(two.networks.instance.name);
    expect(one.volumes.mysql_data.name).not.toBe(two.volumes.mysql_data.name);

    // Both instances are healthy behind the shared proxy.
    expect((await instanceHealth(d, 'qa-one')).overall).toBe('healthy');
    expect((await instanceHealth(d, 'qa-two')).overall).toBe('healthy');
  });
});
