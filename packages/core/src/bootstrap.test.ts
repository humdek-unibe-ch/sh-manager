// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreRelease, FrontendRelease } from '@shm/schemas';
import { RecordingComposeRunner } from '@shm/docker';
import { InventoryStore, LockStore, ManifestStore, type InstanceSecrets } from '@shm/instances';
import { buildInstanceInstallArtifacts, buildServerBootstrap, installInstance } from './bootstrap.js';

// Deterministic secrets so install tests stay fast (real generation is covered
// by secrets.test.ts; RSA keygen would otherwise dominate the suite runtime).
const fakeSecrets: InstanceSecrets = {
  appSecret: 'a'.repeat(64),
  databaseName: 'selfhelp',
  databaseUser: 'selfhelp',
  databasePassword: 'db-password-value',
  databaseRootPassword: 'db-root-password-value',
  redisPassword: 'redis-password-value',
  mercureJwtSecret: 'm'.repeat(64),
  jwtPassphrase: 'jwt-passphrase-value',
  jwtPrivateKeyPem: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMOCK\n-----END ENCRYPTED PRIVATE KEY-----\n',
  jwtPublicKeyPem: '-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----\n',
  managerToken: 'manager-token-value',
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shm-core-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const core: CoreRelease = {
  kind: 'selfhelp-core-release',
  id: 'selfhelp-core-1.5.0',
  version: '1.5.0',
  channel: 'stable',
  releasedAt: '2026-06-01T00:00:00Z',
  minimumDirectUpgradeFrom: '1.0.0',
  pluginApiVersion: '2.1',
  backend: { image: 'ghcr.io/selfhelp/backend:1.5.0', digest: 'sha256:b' },
  worker: { image: 'ghcr.io/selfhelp/worker:1.5.0', digest: 'sha256:w' },
  scheduler: { image: 'ghcr.io/selfhelp/scheduler:1.5.0', digest: 'sha256:s' },
  frontendCompatibility: { requiredFrontendRange: '>=1.5.0 <1.6.0' },
  database: { migrationRange: 'Version20260605081254', destructive: false, requiresBackup: true, manualConfirmationRequired: false },
  security: { signature: 'sig', keyId: 'official-2026', signedPayloadSha256: 'sha256:p' },
};
const frontend: FrontendRelease = {
  kind: 'selfhelp-frontend-release',
  id: 'selfhelp-frontend-1.5.0',
  version: '1.5.0',
  channel: 'stable',
  image: 'ghcr.io/selfhelp/frontend:1.5.0',
  digest: 'sha256:f',
  backendCompatibility: { requiredCoreRange: '>=1.5.0 <1.6.0', requiredApiVersion: '2.1' },
  security: { signature: 'sig', keyId: 'official-2026' },
};

function installInput(mode: 'production' | 'local') {
  return {
    instanceId: 'website1',
    displayName: 'Website 1',
    mode,
    domain: mode === 'production' ? 'website1.example.ch' : undefined,
    localPort: mode === 'local' ? 3001 : undefined,
    root,
    managerVersion: '0.1.0',
    registry: { id: 'selfhelp-official', url: 'https://registry.example/', metadataSha256: 'sha256:idx' },
    core,
    frontend,
    services: {
      mysql: { image: 'mysql:8.4', digest: 'sha256:m' },
      redis: { image: 'redis:7.2', digest: 'sha256:r' },
      mercure: { image: 'dunglas/mercure:0.18', digest: 'sha256:me' },
    },
    mercurePublicUrl: 'https://website1.example.ch/.well-known/mercure',
    createdAt: '2026-06-05T10:00:00Z',
  };
}

describe('buildServerBootstrap', () => {
  it('requires a Let\'s Encrypt email in production', () => {
    expect(() => buildServerBootstrap({ serverId: 's1', managerVersion: '0.1.0', mode: 'production', root })).toThrow(/email/i);
  });
  it('builds a proxy compose + inventory skeleton', () => {
    const b = buildServerBootstrap({ serverId: 's1', managerVersion: '0.1.0', mode: 'production', root, letsencryptEmail: 'ops@example.ch' });
    expect(b.proxyComposeYaml).toContain('traefik');
    expect(b.inventory.proxy.network).toBe('selfhelp_proxy');
    expect(b.inventory.instances).toHaveLength(0);
  });
  it('emits the Let\'s Encrypt bind engine-side when the engine sees the root elsewhere', () => {
    const engineRoot = '/run/desktop/mnt/host/d/selfhelp';
    const b = buildServerBootstrap({
      serverId: 's1',
      managerVersion: '0.1.0',
      mode: 'production',
      root,
      engineRoot,
      letsencryptEmail: 'ops@example.ch',
    });
    expect(b.proxyComposeYaml).toContain(`${engineRoot}/proxy/letsencrypt:/letsencrypt`);
    expect(b.proxyComposeYaml).not.toContain('./letsencrypt');
  });
});

describe('buildInstanceInstallArtifacts', () => {
  it('builds a valid manifest + lock with correct images/versions', () => {
    const a = buildInstanceInstallArtifacts(installInput('production'));
    expect(a.manifest.versions.selfhelp).toBe('1.5.0');
    expect(a.manifest.images.frontend).toBe('ghcr.io/selfhelp/frontend:1.5.0');
    expect(a.lock.core.backendImageDigest).toBe('sha256:b');
    expect(a.lock.core.migrationVersion).toBe('Version20260605081254');
  });

  it('preserves the BFF URL invariant in the generated env', () => {
    const a = buildInstanceInstallArtifacts(installInput('production'));
    expect(a.envText).toContain('NEXT_PUBLIC_API_URL=/api');
    expect(a.envText).toContain('SYMFONY_INTERNAL_URL=http://backend:8080');
    expect(a.envText).not.toContain('NEXT_PUBLIC_API_URL=http://backend');
  });

  it('only routes the frontend through the proxy (compose)', () => {
    const a = buildInstanceInstallArtifacts(installInput('production'));
    expect(a.composeYaml).toContain('selfhelp_proxy');
    expect(a.composeYaml).toContain('traefik.enable=true');
  });

  // Docker Desktop / non-default state mounts: the engine sees the state root
  // at a different path than the manager container, so compose bind sources
  // must be absolute from the ENGINE's point of view.
  it('emits engine-side bind sources when the engine sees the root elsewhere', () => {
    const engineRoot = '/run/desktop/mnt/host/d/selfhelp';
    const a = buildInstanceInstallArtifacts({ ...installInput('production'), engineRoot });
    expect(a.composeYaml).toContain(`${engineRoot}/instances/website1/secrets/jwt:/app/config/jwt:ro`);
    expect(a.composeYaml).not.toContain('./secrets/jwt');
  });

  it('keeps relative bind sources without an engineRoot (same-path Linux mounts)', () => {
    const a = buildInstanceInstallArtifacts(installInput('production'));
    expect(a.composeYaml).toContain('./secrets/jwt:/app/config/jwt:ro');
  });
});

describe('installInstance', () => {
  it('writes all artifacts atomically and updates the inventory', async () => {
    await buildAndInstall();
    const manifest = await new ManifestStore('website1', root).read();
    const lock = await new LockStore('website1', root).read();
    const inventory = await new InventoryStore(root).read();
    expect(manifest.instanceId).toBe('website1');
    expect(lock.core.version).toBe('1.5.0');
    expect(inventory.instances[0]?.composeProject).toBe('selfhelp_website1');

    const compose = await readFile(path.join(root, 'instances', 'website1', 'compose.yaml'), 'utf8');
    expect(compose).toContain('mysql_data');
    const readme = await readFile(path.join(root, 'instances', 'website1', 'README.md'), 'utf8');
    expect(readme.toLowerCase()).not.toContain('app_secret');
  });

  it('generates per-instance secrets to 0600 files and never leaks them into manifest/lock/inventory/readme', async () => {
    const res = await buildAndInstall();
    expect(res.secretsWritten).toBe(9);

    const dir = path.join(root, 'instances', 'website1');
    const secretsEnv = await readFile(path.join(dir, 'secrets', 'secrets.env'), 'utf8');
    expect(secretsEnv).toContain(`APP_SECRET=${fakeSecrets.appSecret}`);
    const jwtPrivate = await readFile(path.join(dir, 'secrets', 'jwt', 'private.pem'), 'utf8');
    expect(jwtPrivate).toContain('PRIVATE KEY');

    // No artifact that is committed/inventoried may contain a raw secret value.
    for (const file of ['selfhelp.instance.json', 'selfhelp.lock.json', 'README.md', '.env']) {
      const text = await readFile(path.join(dir, file), 'utf8');
      expect(text).not.toContain(fakeSecrets.appSecret);
      expect(text).not.toContain(fakeSecrets.databasePassword);
      expect(text).not.toContain(fakeSecrets.jwtPassphrase);
    }
    const inventory = await readFile(path.join(root, 'selfhelp.server.json'), 'utf8');
    expect(inventory).not.toContain(fakeSecrets.appSecret);
  });

  it('brings the stack up through the injected runner when requested', async () => {
    const boot = buildServerBootstrap({ serverId: 's1', managerVersion: '0.1.0', mode: 'production', root, letsencryptEmail: 'ops@example.ch' });
    await new InventoryStore(root).write(boot.inventory);
    const runner = new RecordingComposeRunner();
    const artifacts = buildInstanceInstallArtifacts(installInput('production'));
    const res = await installInstance(artifacts, { root, runner, bringUp: true, secrets: fakeSecrets });
    expect(res.broughtUp).toBe(true);
    expect(runner.calls.at(-1)?.args).toEqual(['up', '-d']);
  });

  it('re-running install over a partial instance keeps the existing on-disk secrets (retry-safe)', async () => {
    await buildAndInstall();
    const secretsEnvPath = path.join(root, 'instances', 'website1', 'secrets', 'secrets.env');
    const before = await readFile(secretsEnvPath, 'utf8');

    // Retry without injected secrets: a fresh set would lock the stack out of
    // the MySQL/Redis volumes initialised by the first attempt, so the
    // existing files must be reused verbatim.
    const artifacts = buildInstanceInstallArtifacts(installInput('production'));
    await installInstance(artifacts, { root });

    expect(await readFile(secretsEnvPath, 'utf8')).toBe(before);
    expect(before).toContain(`MYSQL_PASSWORD=${fakeSecrets.databasePassword}`);
  });

  async function buildAndInstall() {
    // server inventory must exist before upserting an instance entry
    const boot = buildServerBootstrap({ serverId: 's1', managerVersion: '0.1.0', mode: 'production', root, letsencryptEmail: 'ops@example.ch' });
    await new InventoryStore(root).write(boot.inventory);
    const artifacts = buildInstanceInstallArtifacts(installInput('production'));
    return installInstance(artifacts, { root, secrets: fakeSecrets });
  }
});
