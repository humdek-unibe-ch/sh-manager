// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Server bootstrap + per-instance install.
 *
 * Pure builders assemble every artifact (proxy compose, instance compose, env,
 * manifest, lock, readme, inventory entry) in memory; the executors write them
 * atomically and (optionally) bring the stack up through the injected
 * {@link ComposeRunner}. No `npm build` / `composer install` / compilation ever
 * happens on the server: only ready-built, signed images are referenced.
 */
import { mkdir } from 'node:fs/promises';
import type {
  CoreRelease,
  FrontendRelease,
  InstalledPlugin,
  InstanceLock,
  InstanceManifest,
  InstanceMode,
  InstanceResourceConfig,
  InventoryInstanceEntry,
  LockPluginEntry,
  LockServiceEntry,
  ReleaseChannel,
  ServerInventory,
} from '@shm/schemas';
import {
  buildInstanceEnv,
  buildInstanceRouting,
  composeProjectName,
  generateInstanceComposeYaml,
  composeCommands,
  renderDotEnv,
  toEnginePath,
  type ComposeRunner,
} from '@shm/docker';
import { proxyComposeToYaml } from '@shm/traefik';
import {
  InventoryStore,
  LockStore,
  ManifestStore,
  ensureManagerToken,
  generateInstanceReadme,
  generateInstanceSecrets,
  instanceDirectories,
  instancePaths,
  proxyDir,
  readInstanceSecrets,
  withMailerDsn,
  writeFileAtomic,
  writeInstanceSecrets,
  type InstanceSecrets,
  type SecretIO,
} from '@shm/instances';

export interface ServerBootstrapInput {
  serverId: string;
  managerVersion: string;
  mode: InstanceMode;
  root: string;
  /**
   * The Docker ENGINE's view of `root` when it differs from the manager
   * container's (Docker Desktop, non-default mounts). Bind-mount sources in
   * generated compose files are emitted from the engine's point of view.
   */
  engineRoot?: string;
  letsencryptEmail?: string;
  proxyNetwork?: string;
}

export interface ServerBootstrapArtifacts {
  inventory: ServerInventory;
  proxyComposeYaml: string;
  proxyComposePath: string;
  steps: string[];
}

export function buildServerBootstrap(input: ServerBootstrapInput): ServerBootstrapArtifacts {
  const network = input.proxyNetwork ?? 'selfhelp_proxy';
  const proxyComposePath = `${proxyDir(input.root)}/compose.yaml`;
  const proxyHostBindDir = input.engineRoot
    ? toEnginePath(proxyDir(input.root), { containerRoot: input.root, engineRoot: input.engineRoot })
    : undefined;
  const proxyComposeYaml = proxyComposeToYaml({
    mode: input.mode === 'production' ? 'production' : 'local',
    network,
    letsencryptEmail: input.letsencryptEmail,
    ...(proxyHostBindDir ? { hostBindDir: proxyHostBindDir } : {}),
  });
  const inventory: ServerInventory = {
    inventoryVersion: 1,
    serverId: input.serverId,
    manager: { name: 'SelfHelp Manager', repository: 'sh-manager', version: input.managerVersion },
    proxy: { type: 'traefik', network, composePath: proxyComposePath },
    instances: [],
  };
  return {
    inventory,
    proxyComposeYaml,
    proxyComposePath,
    steps: [
      'create /opt/selfhelp layout',
      `create shared proxy network "${network}"`,
      'write proxy compose + start Traefik',
      'write server inventory',
    ],
  };
}

export interface InstanceInstallInput {
  instanceId: string;
  displayName: string;
  mode: InstanceMode;
  domain?: string;
  localPort?: number;
  root: string;
  /** Engine view of `root` when it differs (see {@link ServerBootstrapInput.engineRoot}). */
  engineRoot?: string;
  managerVersion: string;
  channel?: ReleaseChannel;
  registry: { id: string; url: string; metadataSha256: string };
  core: CoreRelease;
  frontend: FrontendRelease;
  services: { mysql: LockServiceEntry; redis: LockServiceEntry; mercure: LockServiceEntry };
  resources?: InstanceResourceConfig;
  installedPlugins?: InstalledPlugin[];
  pluginLock?: Record<string, LockPluginEntry>;
  createdAt?: string;
  operationId?: string;
  /**
   * `SELFHELP_PLUGIN_TRUSTED_KEYS` value for the backend (format from
   * `formatTrustedKeysEnv`). Installs/updates pass the manager's own trusted
   * keys so the CMS can verify + list signed registry plugins.
   */
  pluginTrustedKeys?: string;
  /**
   * Operator-set non-secret env overrides. Persisted on the manifest and merged
   * into the generated `.env` (see {@link buildInstanceEnv}); structural keys
   * are never overridable. Carried through update/clone/address-change so the
   * operator's tuning survives every regeneration.
   */
  envOverrides?: Record<string, string>;
}

export interface InstanceInstallArtifacts {
  manifest: InstanceManifest;
  lock: InstanceLock;
  composeYaml: string;
  envText: string;
  readme: string;
  inventoryEntry: InventoryInstanceEntry;
}

function publicUrlFor(input: InstanceInstallInput): string {
  if (input.mode === 'production') {
    if (!input.domain) throw new Error('Production install requires a domain.');
    return `https://${input.domain}`;
  }
  if (input.localPort === undefined) throw new Error('Local install requires a localPort.');
  return `http://localhost:${input.localPort}`;
}

export function buildInstanceInstallArtifacts(input: InstanceInstallInput): InstanceInstallArtifacts {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const publicFrontendUrl = publicUrlFor(input);
  const routing = buildInstanceRouting({
    instanceId: input.instanceId,
    mode: input.mode,
    selfhelpVersion: input.core.version,
    frontendVersion: input.frontend.version,
    publicFrontendUrl,
  });

  const images = {
    backend: input.core.backend.image,
    frontend: input.frontend.image,
    scheduler: input.core.scheduler.image,
    worker: input.core.worker.image,
    mysql: input.services.mysql.image,
    redis: input.services.redis.image,
    mercure: input.services.mercure.image,
  };

  const manifest: InstanceManifest = {
    manifestVersion: 1,
    instanceId: input.instanceId,
    displayName: input.displayName,
    domain: input.mode === 'production' ? input.domain! : `localhost:${input.localPort}`,
    mode: input.mode,
    createdAt,
    updatedAt: createdAt,
    registry: { id: input.registry.id, url: input.registry.url, channel: input.channel ?? 'stable' },
    versions: {
      selfhelp: input.core.version,
      backend: input.core.version,
      frontend: input.frontend.version,
      scheduler: input.core.version,
      worker: input.core.version,
      pluginApi: input.core.pluginApiVersion,
    },
    images,
    routing,
    installedPlugins: input.installedPlugins ?? [],
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.envOverrides && Object.keys(input.envOverrides).length > 0
      ? { envOverrides: input.envOverrides }
      : {}),
  };

  const lock: InstanceLock = {
    lockfileVersion: 1,
    generatedAt: createdAt,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    registry: input.registry,
    core: {
      version: input.core.version,
      backendImageDigest: input.core.backend.digest,
      frontendImageDigest: input.frontend.digest,
      schedulerImageDigest: input.core.scheduler.digest,
      workerImageDigest: input.core.worker.digest,
      migrationVersion: input.core.database.migrationRange,
      pluginApiVersion: input.core.pluginApiVersion,
      signedPayloadSha256: input.core.security.signedPayloadSha256 ?? input.core.security.signature,
    },
    services: input.services,
    plugins: input.pluginLock ?? {},
  };

  const envText = renderDotEnv(
    buildInstanceEnv({
      instanceId: input.instanceId,
      mode: input.mode,
      selfhelpVersion: input.core.version,
      frontendVersion: input.frontend.version,
      publicFrontendUrl,
      registryUrl: input.registry.url,
      ...(input.pluginTrustedKeys ? { pluginTrustedKeys: input.pluginTrustedKeys } : {}),
      ...(input.envOverrides ? { envOverrides: input.envOverrides } : {}),
    }),
  );

  // Bind sources are engine-side paths: absolute when the engine sees the
  // state root elsewhere (Docker Desktop), relative otherwise (unchanged).
  const hostBindDir = input.engineRoot
    ? toEnginePath(instancePaths(input.instanceId, input.root).dir, {
        containerRoot: input.root,
        engineRoot: input.engineRoot,
      })
    : undefined;

  const composeYaml = generateInstanceComposeYaml({
    instanceId: input.instanceId,
    mode: input.mode,
    images,
    domain: input.domain,
    localPort: input.localPort,
    resources: input.resources,
    ...(hostBindDir ? { hostBindDir } : {}),
  });

  const readme = generateInstanceReadme(manifest, { managerVersion: input.managerVersion, root: input.root });

  const inventoryEntry: InventoryInstanceEntry = {
    instanceId: input.instanceId,
    domain: manifest.domain,
    path: instancePaths(input.instanceId, input.root).dir,
    composeProject: composeProjectName(input.instanceId),
    status: 'active',
  };

  return { manifest, lock, composeYaml, envText, readme, inventoryEntry };
}

export interface InstallDeps {
  root: string;
  runner?: ComposeRunner;
  bringUp?: boolean;
  /**
   * Pre-generated secrets (tests inject deterministic ones). Defaults to a fresh,
   * fully isolated secret set so every install boots with its own credentials.
   */
  secrets?: InstanceSecrets;
  /** Injectable secret-file IO (defaults to the real 0600/0700 node writer). */
  secretIO?: SecretIO;
  /**
   * Operator SMTP DSN, stored in secrets.env (may carry credentials).
   * `undefined` keeps an existing override (retry/resume); `''` clears it.
   */
  mailerDsn?: string;
}

/** Writes all instance artifacts atomically and optionally brings the stack up. */
export async function installInstance(
  artifacts: InstanceInstallArtifacts,
  deps: InstallDeps,
): Promise<{ instanceDir: string; broughtUp: boolean; secretsWritten: number }> {
  const id = artifacts.manifest.instanceId;
  const paths = instancePaths(id, deps.root);

  for (const dir of instanceDirectories(paths)) {
    await mkdir(dir, { recursive: true });
  }

  // A new instance gets freshly generated, isolated secrets written to 0600
  // files before the stack is brought up. Re-running install over a PARTIAL
  // instance (retry after a failed first attempt) reuses the existing on-disk
  // set instead: the MySQL/Redis volumes were already initialised with those
  // credentials, and a fresh set would lock the stack out of its own database.
  // Secrets never enter the manifest, lock, inventory, or README.
  // A reused pre-token set gets a manager token minted (safe: it protects no
  // persisted data) so the CMS<->Manager update loop works after the install.
  const existing = deps.secrets ?? (await readInstanceSecrets(paths.secretsDir));
  const secrets = withMailerDsn(
    ensureManagerToken(existing ?? generateInstanceSecrets()).secrets,
    deps.mailerDsn,
  );
  const writtenSecrets = await writeInstanceSecrets(paths.secretsDir, secrets, deps.secretIO);

  await writeFileAtomic(paths.composePath, artifacts.composeYaml);
  await writeFileAtomic(paths.envPath, artifacts.envText);
  await writeFileAtomic(paths.readmePath, artifacts.readme);
  await new ManifestStore(id, deps.root).write(artifacts.manifest);
  await new LockStore(id, deps.root).write(artifacts.lock);
  await new InventoryStore(deps.root).upsertInstance(artifacts.inventoryEntry);

  let broughtUp = false;
  if (deps.bringUp && deps.runner) {
    await deps.runner.run(paths.dir, composeCommands.upDetached());
    broughtUp = true;
  }
  return { instanceDir: paths.dir, broughtUp, secretsWritten: writtenSecrets.length };
}
