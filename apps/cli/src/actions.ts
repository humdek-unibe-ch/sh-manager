// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * CLI actions. All side effects (Docker, registry fetch, resource probing,
 * health probing, image-digest resolution) are injected via {@link ActionDeps}
 * so the offline paths are unit-testable and the real wiring lives in env.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import { validateInstanceManifest } from '@shm/schemas';
import type {
  BackupManifest,
  CoreRelease,
  FrontendRelease,
  InstanceLock,
  InstanceManifest,
  InstanceMode,
  LockServiceEntry,
  PluginRelease,
  RegistryReleaseRef,
  ReleaseChannel,
  TrustedKeysFile,
} from '@shm/schemas';
import type { ComposeRunner } from '@shm/docker';
import { DEFAULT_PROXY_NETWORK, buildInstanceRouting, composeCommands, composeProjectName, generateInstanceComposeYaml, toEnginePath } from '@shm/docker';
import type { Fetcher } from '@shm/registry';
import { RegistryClient } from '@shm/registry';
import {
  assertSafeToBootstrap,
  assessBootstrapTarget,
  buildInstanceInstallArtifacts,
  buildServerBootstrap,
  evaluateHealth,
  evaluateMysqlMajorUpgrade,
  executeUpdate,
  installInstance,
  planUpdate,
  resolveTargetRuntimeImages,
  processNextOperation,
  drainOperations,
  provisionInstance,
  runPreflight,
  type BackendOperationsClient,
  type BootstrapTargetFacts,
  type HealthReport,
  type OperationExecutor,
  type PreflightResourceFacts,
  type ProcessOutcome,
  type ProvisionReport,
  type ProvisionStepName,
  type ServiceProbeResult,
  type UpdatePlan,
} from '@shm/core';
import {
  InventoryStore,
  LockStore,
  ManifestStore,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
  ensureManagerToken,
  generateCloneSecrets,
  instancePaths,
  instancesDir,
  nodeSecretIO,
  planRemove,
  proxyDir,
  readInstanceSecrets,
  secretsForRestore,
  serverInventoryPath,
  validateDomainForInstall,
  writeFileAtomic,
  writeInstanceSecrets,
  type GenerateSecretsOptions,
  type InstancePaths,
  type RemoveMode,
  type RemovePlan,
  type SecretIO,
} from '@shm/instances';
import {
  REQUIRED_BACKUP_AREAS,
  buildBackupManifest,
  makeBackupId,
  planClone,
  planRestore,
  validateBackupForRestore,
  type BackupValidation,
  type ClonePlan,
  type CloneRequest,
  type RestoreMode,
  type RestorePlan,
  type RestoreRequest,
} from '@shm/backup';
import { assembleSupportBundle, redactEnv } from '@shm/support';

export interface ActionDeps {
  root: string;
  /**
   * The Docker ENGINE's view of `root` when it differs from this process's
   * (manager running containerized with the state mounted at another path —
   * the Docker Desktop / Windows case). Every path handed to the engine
   * (compose bind sources, backup helper mounts) is rewritten through it.
   * Unset = same-path mounts, today's Linux production behaviour.
   */
  engineRoot?: string;
  managerVersion: string;
  trustedKeys: TrustedKeysFile;
  runner: ComposeRunner;
  fetcher: Fetcher;
  resolveServiceDigests: (images: {
    mysql: string;
    redis: string;
    mercure: string;
  }) => Promise<{ mysql: LockServiceEntry; redis: LockServiceEntry; mercure: LockServiceEntry }>;
  probeHealth: (publicUrl: string, apiPrefix: string) => Promise<ServiceProbeResult[]>;
  resourceFacts: (requiredPorts: number[]) => Promise<PreflightResourceFacts>;
  /** Idempotently create a Docker network (real impl uses `docker network create`). */
  ensureNetwork?: (name: string) => Promise<void>;
  /** Archive a named Docker volume into `outFile` (real impl uses `docker run … tar`). */
  archiveVolume?: (volumeName: string, outFile: string) => Promise<void>;
  /** Delete named Docker volumes (full-delete only; real impl uses `docker volume rm`). */
  removeVolumes?: (volumeNames: string[]) => Promise<void>;
  /** Restore a backup `.tgz` (from {@link archiveVolume}) into a named volume, replacing its contents. */
  extractVolume?: (tgz: string, volumeName: string) => Promise<void>;
  /** Copy the full contents of one named Docker volume into another (clone). */
  copyVolume?: (sourceVolume: string, destVolume: string) => Promise<void>;
  /** Import a SQL dump into the instance's mysql container (`compose exec -T mysql mysql … < dump`). */
  importDatabase?: (instanceDir: string, sqlFile: string) => Promise<void>;
  /** Injected secret-file writer (tests assert isolation without POSIX perms). */
  secretIO?: SecretIO;
  /** RSA modulus for clone/restore JWT keygen; tests lower it for speed. */
  jwtModulusLength?: number;
  /** Sleep used by the install DB-readiness retry loop (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** DB-readiness retry budget for provisioning (defaults: 60 attempts x 2s). */
  dbWaitAttempts?: number;
  dbWaitDelayMs?: number;
  /** Resolve a domain's A/AAAA records (production DNS-binding check). */
  resolveDns?: (host: string) => Promise<{ a: string[]; aaaa: string[] }>;
  /** Best-effort public IP of this server, to confirm a domain points here. */
  serverPublicIp?: () => Promise<string | undefined>;
  now?: () => string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * MySQL "Access denied" (SQLSTATE 1045 / ER_ACCESS_DENIED_ERROR) is a
 * credential mismatch, not slow startup, so retrying cannot fix it. It almost
 * always means the instance's mysql_data volume was initialised by an EARLIER
 * install with different generated secrets: the official mysql image applies
 * MYSQL_USER/MYSQL_PASSWORD only on the first initialisation of an empty
 * volume, so once secrets are regenerated the stack is locked out of its own
 * database forever.
 */
function isDbCredentialError(message: string): boolean {
  return /access denied for user|SQLSTATE\[HY000\] \[1045\]|ERROR 1045/i.test(message);
}

/** Consecutive credential rejections tolerated before failing fast. */
const DB_CREDENTIAL_FAILURE_LIMIT = 3;

function dbCredentialMismatchError(instanceId: string, lastErr: unknown): Error {
  const volume = `${composeProjectName(instanceId)}_mysql_data`;
  return new Error(
    `MySQL rejected the instance credentials (Access denied). The database volume "${volume}" was ` +
      `initialised with DIFFERENT credentials than the ones in instances/${instanceId}/secrets/secrets.env — ` +
      `usually a volume left over from an earlier install attempt whose secrets were since regenerated. ` +
      `Waiting longer cannot fix this. Either restore the original secrets/secrets.env, or remove the ` +
      `instance INCLUDING its volumes and reinstall:\n` +
      `  sh-manager instance remove ${instanceId} --mode full_delete --delete-volumes --confirm "delete ${instanceId}"\n` +
      `Underlying error: ${errMessage(lastErr)}`,
  );
}

function secretGenOptions(deps: ActionDeps): GenerateSecretsOptions {
  return deps.jwtModulusLength === undefined ? {} : { jwtModulusLength: deps.jwtModulusLength };
}

/**
 * Waits until the instance's MySQL container accepts an AUTHENTICATED root
 * connection, so a restore/clone can import a dump before the rest of the stack
 * starts. Bounded by the same retry budget as provisioning; in tests the
 * recording runner returns immediately so no sleeping happens.
 *
 * It runs a real `SELECT 1` as `root@localhost` rather than `mysqladmin ping`:
 * during the MySQL entrypoint's first-boot temp-init phase the server already
 * answers `ping` while `root@localhost` does not yet have its real password, so
 * a ping-only gate lets the import connect too early and fail with
 * "ERROR 1045 (28000): Access denied for user 'root'@'localhost'". Gating on the
 * same auth path the import uses removes that race.
 */
async function waitForMysqlReady(deps: ActionDeps, instanceDir: string): Promise<void> {
  const attempts = deps.dbWaitAttempts ?? 60;
  const delayMs = deps.dbWaitDelayMs ?? 2000;
  const sleep = deps.sleep ?? realSleep;
  let lastErr: unknown;
  let credentialFailures = 0;
  for (let i = 0; i < attempts; i++) {
    try {
      await deps.runner.run(instanceDir, [
        'exec',
        '-T',
        'mysql',
        'sh',
        '-lc',
        'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1"',
      ]);
      return;
    } catch (err) {
      lastErr = err;
      // Deterministic credential mismatch (stale volume): fail fast with
      // remediation instead of burning the whole retry budget (see
      // isDbCredentialError). The first-boot temp-init phase never answers TCP,
      // so a couple of consecutive denials is conclusive.
      if (isDbCredentialError(errMessage(err))) {
        if (++credentialFailures >= DB_CREDENTIAL_FAILURE_LIMIT) {
          throw dbCredentialMismatchError(path.basename(instanceDir), err);
        }
      } else {
        credentialFailures = 0;
      }
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw new Error(`MySQL not ready after ${attempts} attempts: ${errMessage(lastErr)}`);
}

const DEFAULT_SERVICE_IMAGES = { mysql: 'mysql:8.4', redis: 'redis:7.2', mercure: 'dunglas/mercure:v0.18' };

/**
 * `mysqldump` of every APPLICATION database, run inside the instance's mysql
 * container via `compose exec -T mysql sh -lc <this>`.
 *
 * It deliberately EXCLUDES the MySQL system schemas (`mysql`, `sys`,
 * `information_schema`, `performance_schema`) instead of using
 * `--all-databases`: a clone / DR target is provisioned with its own
 * freshly-generated DB credentials, so importing the source's `mysql.user`
 * rows would overwrite them and lock the new stack out of its own database
 * (the app user could no longer authenticate). Dumping only the app data keeps
 * backups portable and clones credential-isolated. `--routines --triggers`
 * preserve the baseline's stored functions/procedures for the app DB.
 */
const APP_DB_DUMP_CMD =
  'exec mysqldump --no-tablespaces --single-transaction --routines --triggers ' +
  '-uroot -p"$MYSQL_ROOT_PASSWORD" --databases ' +
  '$(mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SHOW DATABASES" ' +
  '| grep -Ev "^(mysql|sys|information_schema|performance_schema)$")';

function registryClient(deps: ActionDeps, baseUrl: string): RegistryClient {
  return new RegistryClient({ baseUrl, trustedKeys: deps.trustedKeys, managerVersion: deps.managerVersion, fetcher: deps.fetcher });
}

// ---------------------------------------------------------------------------
// server init
// ---------------------------------------------------------------------------

export interface ServerInitOptions {
  serverId: string;
  mode: InstanceMode;
  letsencryptEmail?: string;
  proxyNetwork?: string;
  /** Acknowledge import/repair of an already-bootstrapped or partial target. */
  allowImport?: boolean;
  /**
   * Wizard retry/resume: the instance id the caller is about to (re)install.
   * A failed first attempt leaves the target half-bootstrapped (inventory /
   * proxy compose / instance dir on disk), and the wizard's in-memory "retry"
   * acknowledgement is lost when the manager restarts (e.g. the operator
   * pulled an updated image before retrying). When the target's existing
   * state is just that — no instances yet, or only THIS instance — re-running
   * the bootstrap is a safe continuation, so it proceeds as an import instead
   * of failing with "already bootstrapped". A target with OTHER instances
   * still refuses without an explicit {@link allowImport}.
   */
  resumeInstanceId?: string;
}

async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false);
}

async function listInstanceDirs(root: string): Promise<string[]> {
  return readdir(instancesDir(root), { withFileTypes: true })
    .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
    .catch(() => [] as string[]);
}

/** Filesystem-level bootstrap target discovery (Docker-label scan is optional). */
async function discoverBootstrapTarget(root: string): Promise<BootstrapTargetFacts> {
  return {
    inventoryExists: await pathExists(serverInventoryPath(root)),
    proxyComposeExists: await pathExists(`${proxyDir(root)}/compose.yaml`),
    instanceDirsOnDisk: await listInstanceDirs(root),
  };
}

export async function serverInit(deps: ActionDeps, opts: ServerInitOptions): Promise<{ proxyComposePath: string; inventoryPath: string }> {
  // Never overwrite an already-managed or partial/foreign install unless the
  // operator explicitly acknowledges import/repair — or this is a safe
  // continuation of a half-finished bootstrap of the SAME instance (see
  // ServerInitOptions.resumeInstanceId).
  const facts = await discoverBootstrapTarget(deps.root);
  const resumable =
    opts.resumeInstanceId !== undefined &&
    (facts.instanceDirsOnDisk.length === 0 ||
      facts.instanceDirsOnDisk.every((dir) => dir === opts.resumeInstanceId));
  assertSafeToBootstrap(assessBootstrapTarget(facts), {
    allowImport: (opts.allowImport ?? false) || resumable,
  });

  const boot = buildServerBootstrap({
    serverId: opts.serverId,
    managerVersion: deps.managerVersion,
    mode: opts.mode,
    root: deps.root,
    ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
    ...(opts.letsencryptEmail ? { letsencryptEmail: opts.letsencryptEmail } : {}),
    ...(opts.proxyNetwork ? { proxyNetwork: opts.proxyNetwork } : {}),
  });
  await writeFileAtomic(boot.proxyComposePath, boot.proxyComposeYaml);
  const store = new InventoryStore(deps.root);
  // Import/repair must never orphan already-registered instances: a fresh
  // bootstrap inventory starts empty, so carry the existing entries over.
  const existing = await store.read().catch(() => null);
  await store.write(existing ? { ...boot.inventory, instances: existing.instances } : boot.inventory);

  // Every instance compose references the shared proxy network as `external`,
  // so bootstrap must guarantee it exists — otherwise the very first
  // `instance install --up` fails with "network … declared as external, but
  // could not be found". In production the shared Traefik proxy is started
  // here too; local mode routes via published ports and needs no proxy
  // container (and must not grab 80/443 on a dev machine).
  await deps.ensureNetwork?.(boot.inventory.proxy.network);
  if (opts.mode === 'production') {
    await deps.runner.run(proxyDir(deps.root), composeCommands.upDetached());
  }
  return { proxyComposePath: boot.proxyComposePath, inventoryPath: store.path };
}

// ---------------------------------------------------------------------------
// instance list
// ---------------------------------------------------------------------------

export async function instanceList(deps: ActionDeps): Promise<{ instanceId: string; domain: string; status: string; composeProject: string }[]> {
  const inv = await new InventoryStore(deps.root).read();
  const rows: { instanceId: string; domain: string; status: string; composeProject: string }[] = [];
  for (const i of inv.instances) {
    // A registered instance whose manifest is missing/invalid must surface as
    // `broken` (repairable) instead of exploding later with a raw ENOENT.
    const manifestOk = await new ManifestStore(i.instanceId, deps.root)
      .read()
      .then(() => true)
      .catch(() => false);
    rows.push({
      instanceId: i.instanceId,
      domain: i.domain,
      status: manifestOk ? i.status : 'broken',
      composeProject: i.composeProject,
    });
  }

  // Instance directories on disk that the inventory does not know about
  // (interrupted installs, hand-edited state) surface as broken too — an
  // instance must never disappear silently. A folder holding ONLY retained
  // backups (what full_delete leaves behind on purpose) is not an instance.
  const known = new Set(rows.map((r) => r.instanceId));
  const dirNames = await readdir(instancesDir(deps.root), { withFileTypes: true })
    .then((entries) => entries.filter((d) => d.isDirectory()).map((d) => d.name))
    .catch(() => [] as string[]);
  for (const name of dirNames) {
    if (known.has(name)) continue;
    if (await looksLikeInstanceState(instancePaths(name, deps.root))) {
      rows.push({ instanceId: name, domain: '', status: 'broken', composeProject: composeProjectName(name) });
    }
  }
  return rows;
}

/** True when the directory carries real instance state (not just retained backups). */
async function looksLikeInstanceState(paths: InstancePaths): Promise<boolean> {
  for (const marker of [paths.manifestPath, paths.lockPath, paths.composePath, paths.secretsDir]) {
    if (await stat(marker).then(() => true, () => false)) return true;
  }
  return false;
}

/**
 * Reads an instance manifest, turning a raw ENOENT into operator guidance:
 * which state root was searched, which instances exist there, and how to
 * repair a damaged instance. Every id-taking CLI action reads through this.
 */
async function readManifestFriendly(deps: ActionDeps, instanceId: string): Promise<InstanceManifest> {
  try {
    return await new ManifestStore(instanceId, deps.root).read();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const known = await new InventoryStore(deps.root)
      .read()
      .then((inv) => inv.instances.map((i) => i.instanceId))
      .catch(() => [] as string[]);
    throw new Error(
      `Instance "${instanceId}" not found in this state root (${deps.root}). ` +
        (known.length > 0
          ? `Known instances: ${known.join(', ')}.`
          : 'No instances are registered on this server.') +
        ` If the instance's files exist but its manifest is missing or damaged, run: sh-manager instance repair ${instanceId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// instance install
// ---------------------------------------------------------------------------

export interface InstanceInstallOptions {
  instanceId: string;
  displayName: string;
  mode: InstanceMode;
  domain?: string;
  localPort?: number;
  /** Production: block (not just warn) when DNS does not resolve to this server. */
  strictDns?: boolean;
  registryUrl: string;
  channel?: ReleaseChannel;
  version?: string;
  bringUp?: boolean;
  /**
   * Run post-`up` provisioning (wait for DB → migrate → create admin → install
   * plugins → warm caches → health). Implies bringUp.
   */
  provision?: boolean;
  /** Create the first CMS admin during provisioning. */
  adminEmail?: string;
  adminName?: string;
  /** Admin password; when omitted a strong one is generated and returned once. */
  adminPassword?: string;
  /**
   * Absolute `plugin.json` paths reachable INSIDE the backend container to
   * install during provisioning (dispatched through `selfhelp:plugin:install`;
   * the stack's worker finalises them via the documented Messenger pipeline).
   */
  pluginManifests?: string[];
  /**
   * Live progress callback, fired when the install enters a stage: `registry`,
   * `compose`, `start`, then the provisioning steps (`wait_db`, `migrations`,
   * `seed`, `admin`, `plugins`, `cache_warm`, `health`). The manager GUI
   * journals these so the create wizard can show a real step checklist.
   */
  onStep?: (step: string) => void | Promise<void>;
}

async function fetchAllFrontends(client: RegistryClient, refs: RegistryReleaseRef[], channel: string): Promise<FrontendRelease[]> {
  const wanted = refs.filter((r) => r.channel === channel && !r.blocked);
  const out: FrontendRelease[] = [];
  for (const r of wanted) out.push((await client.getFrontendRelease(r)).release);
  return out;
}

function selectCoreRef<T extends { version: string; channel: string; blocked?: boolean }>(refs: T[], channel: string, target?: string): T {
  const usable = refs.filter((r) => r.channel === channel && !r.blocked);
  if (usable.length === 0) throw new Error(`No core releases on the ${channel} channel.`);
  if (target && target !== 'latest') {
    const exact = usable.find((r) => semver.eq(semver.coerce(r.version) ?? '0.0.0', semver.coerce(target) ?? '0.0.0'));
    if (!exact) throw new Error(`Core version ${target} is not available on ${channel}.`);
    return exact;
  }
  return [...usable].sort((a, b) => semver.rcompare(semver.coerce(a.version) ?? '0.0.0', semver.coerce(b.version) ?? '0.0.0'))[0]!;
}

export async function instanceInstall(
  deps: ActionDeps,
  opts: InstanceInstallOptions,
): Promise<{
  instanceDir: string;
  version: string;
  broughtUp: boolean;
  provision?: ProvisionReport;
  adminPassword?: string;
  /** Restricted (0600) server-side file holding the generated admin password. */
  adminPasswordFile?: string;
  domainWarnings: string[];
}> {
  // Fail fast on duplicate domains / bad DNS before touching the registry or disk.
  const domainWarnings = await assertInstallableDomain(deps, opts);

  const channel = opts.channel ?? 'stable';
  const client = registryClient(deps, opts.registryUrl);
  await opts.onStep?.('registry');
  const index = await client.getIndex();

  const coreRef = selectCoreRef(index.core, channel, opts.version);
  const core = (await client.getCoreRelease(coreRef)).release;
  const frontends = await fetchAllFrontends(client, index.frontend, channel);
  const frontend = pickCompatibleFrontend(core, frontends);
  if (!frontend) throw new Error(`No compatible frontend release for core ${core.version}.`);

  const serviceImages = {
    mysql: core.runtime?.mysql.recommendedImage ?? DEFAULT_SERVICE_IMAGES.mysql,
    redis: core.runtime?.redis.recommendedImage ?? DEFAULT_SERVICE_IMAGES.redis,
    mercure: core.runtime?.mercure.recommendedImage ?? DEFAULT_SERVICE_IMAGES.mercure,
  };
  const services = await deps.resolveServiceDigests(serviceImages);

  await opts.onStep?.('compose');
  const artifacts = buildInstanceInstallArtifacts({
    instanceId: opts.instanceId,
    displayName: opts.displayName,
    mode: opts.mode,
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.localPort !== undefined ? { localPort: opts.localPort } : {}),
    root: deps.root,
    ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
    managerVersion: deps.managerVersion,
    channel,
    registry: { id: index.publisher.name, url: opts.registryUrl, metadataSha256: client.lastSuccessfulCheck?.metadataSha256 ?? '' },
    core,
    frontend,
    services,
  });

  // Provisioning requires a running stack, so it implies bringUp.
  const bringUp = (opts.bringUp ?? false) || (opts.provision ?? false);
  if (bringUp) await opts.onStep?.('start');
  // The instance compose declares the shared proxy network as external; make
  // sure it exists even on servers bootstrapped by an older manager.
  if (bringUp && deps.ensureNetwork) {
    const network = await new InventoryStore(deps.root)
      .read()
      .then((inv) => inv.proxy.network)
      .catch(() => DEFAULT_PROXY_NETWORK);
    await deps.ensureNetwork(network);
  }
  const res = await installInstance(artifacts, { root: deps.root, runner: deps.runner, bringUp });

  if (!opts.provision) {
    return { instanceDir: res.instanceDir, version: core.version, broughtUp: res.broughtUp, domainWarnings };
  }

  // Admin bootstrap password policy: an explicitly supplied password is used
  // as-is and never written to disk (the operator already has it). A GENERATED
  // one is persisted to <instance>/secrets/admin_password (0600) so it can be
  // retrieved after the installer output is gone, and so a resumed install
  // reuses the password the admin row was already created with instead of
  // regenerating. It is returned to the caller exactly once and never enters
  // the manifest, lock, inventory, or any log.
  let generatedPassword: string | undefined;
  let adminPasswordFile: string | undefined;
  if (opts.adminEmail && !opts.adminPassword) {
    const persisted = await persistOrReuseAdminPassword(deps, opts.instanceId);
    generatedPassword = persisted.password;
    adminPasswordFile = persisted.file;
  }
  const provision = await runInstanceProvisioning(deps, opts, artifacts, core.version, generatedPassword);

  return {
    instanceDir: res.instanceDir,
    version: core.version,
    broughtUp: res.broughtUp,
    provision,
    domainWarnings,
    ...(generatedPassword ? { adminPassword: generatedPassword } : {}),
    ...(adminPasswordFile ? { adminPasswordFile } : {}),
  };
}

/** Filename of the generated admin bootstrap password inside `<instance>/secrets/`. */
export const ADMIN_PASSWORD_FILENAME = 'admin_password';

/**
 * Returns the instance's generated admin bootstrap password, creating and
 * persisting it on first use. The 0600 file under the instance's `secrets/`
 * directory is the operator's retrieval point once the installer output is
 * gone (web wizard closed, scrollback lost) and the resume anchor for a
 * retried install: the CMS admin row already carries the FIRST attempt's
 * password, so a retry must reuse it, never regenerate.
 */
async function persistOrReuseAdminPassword(
  deps: ActionDeps,
  instanceId: string,
): Promise<{ password: string; file: string }> {
  const paths = instancePaths(instanceId, deps.root);
  const file = path.join(paths.secretsDir, ADMIN_PASSWORD_FILENAME);
  const existing = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (existing !== '') return { password: existing, file };
  const io = deps.secretIO ?? nodeSecretIO;
  const password = randomBytes(18).toString('base64url');
  await io.ensureDir(paths.secretsDir, SECRET_DIR_MODE);
  await io.writeFile(file, `${password}\n`, SECRET_FILE_MODE);
  return { password, file };
}

/**
 * Duplicate-domain prevention + optional production DNS-binding check. Throws a
 * clear aggregated error when the domain cannot be installed; returns non-fatal
 * warnings (e.g. DNS not yet pointing here) for the caller to surface.
 * Shared by install and address changes (structural subset of install options).
 */
async function assertInstallableDomain(
  deps: ActionDeps,
  opts: { instanceId: string; mode: InstanceMode; domain?: string; localPort?: number; strictDns?: boolean },
): Promise<string[]> {
  const existingEntries = await new InventoryStore(deps.root)
    .read()
    .then((inv) => inv.instances)
    .catch(() => [] as { instanceId: string; domain: string }[]);
  const existingDomains = existingEntries.map((e) => e.domain);
  // Re-installing over the SAME instance id (retry after a failed first
  // attempt) keeps its own domain claim; only other instances' domains conflict.
  const ownDomain = existingEntries.find((e) => e.instanceId === opts.instanceId)?.domain;

  let dns: { a: string[]; aaaa: string[] } | undefined;
  let serverPublicIp: string | undefined;
  if (opts.mode === 'production' && opts.domain && deps.resolveDns) {
    dns = await deps.resolveDns(opts.domain).catch(() => ({ a: [], aaaa: [] }));
    serverPublicIp = deps.serverPublicIp ? await deps.serverPublicIp().catch(() => undefined) : undefined;
  }

  const check = validateDomainForInstall({
    mode: opts.mode,
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.localPort !== undefined ? { localPort: opts.localPort } : {}),
    existingDomains,
    ...(ownDomain ? { excludeInstanceDomain: ownDomain } : {}),
    ...(dns ? { dns } : {}),
    ...(serverPublicIp ? { serverPublicIp } : {}),
    ...(opts.strictDns !== undefined ? { strictDns: opts.strictDns } : {}),
  });
  if (!check.ok) {
    throw new Error('Domain validation failed:\n' + check.errors.map((e) => `- ${e}`).join('\n'));
  }
  return check.warnings;
}

/**
 * Builds the real Docker-exec executors for {@link provisionInstance}. Every
 * step shells `php bin/console …` into the instance's backend container through
 * the injected compose runner, so it never compiles anything on the server.
 */
async function runInstanceProvisioning(
  deps: ActionDeps,
  opts: InstanceInstallOptions,
  artifacts: { manifest: { routing: { publicFrontendUrl: string; browserApiPrefix: string } } },
  version: string,
  generatedPassword: string | undefined,
): Promise<ProvisionReport> {
  const paths = instancePaths(opts.instanceId, deps.root);
  const consoleExec = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    deps.runner.run(paths.dir, ['exec', '-T', 'backend', 'php', 'bin/console', ...args]);
  const sleep = deps.sleep ?? realSleep;
  const routing = artifacts.manifest.routing;

  // Poll `dbal:run-sql SELECT 1` (exec'd into the backend) until it answers.
  // Used both to wait for MySQL on first boot and to wait for FrankenPHP to
  // finish rebooting after the post-migration restart below.
  const waitForBackendConsole = async (label: string): Promise<void> => {
    const attempts = deps.dbWaitAttempts ?? 60;
    const delayMs = deps.dbWaitDelayMs ?? 2000;
    let lastErr: unknown;
    let credentialFailures = 0;
    for (let i = 0; i < attempts; i++) {
      try {
        await consoleExec(['dbal:run-sql', 'SELECT 1']);
        return;
      } catch (err) {
        lastErr = err;
        // "Access denied" is a deterministic credential mismatch (stale
        // mysql_data volume from an earlier attempt) — retrying for the full
        // budget only delays a clear answer. Fail fast with remediation.
        if (isDbCredentialError(errMessage(err))) {
          if (++credentialFailures >= DB_CREDENTIAL_FAILURE_LIMIT) {
            throw dbCredentialMismatchError(opts.instanceId, err);
          }
        } else {
          credentialFailures = 0;
        }
        if (i < attempts - 1) await sleep(delayMs);
      }
    }
    throw new Error(`${label} after ${attempts} attempts: ${errMessage(lastErr)}`);
  };

  return provisionInstance(
    { instanceId: opts.instanceId, version },
    {
      waitForDatabase: () => waitForBackendConsole('Database not ready'),
      runMigrations: async () => {
        await consoleExec(['doctrine:migrations:migrate', '--no-interaction', '--allow-no-migration']);
      },
      ...(opts.adminEmail
        ? {
            createAdmin: async (): Promise<{ created: boolean; detail?: string }> => {
              const password = opts.adminPassword ?? generatedPassword ?? '';
              if (password === '') throw new Error('No admin password available.');
              await consoleExec([
                'app:create-admin-user',
                opts.adminEmail!,
                opts.adminName ?? 'Admin',
                `--password=${password}`,
              ]);
              return { created: true, detail: opts.adminEmail! };
            },
          }
        : {}),
      ...(opts.pluginManifests && opts.pluginManifests.length > 0
        ? {
            installPlugins: async (): Promise<{ installed: string[]; detail?: string }> => {
              const installed: string[] = [];
              for (const manifestPath of opts.pluginManifests!) {
                await consoleExec(['selfhelp:plugin:install', manifestPath]);
                installed.push(manifestPath);
              }
              return { installed, detail: `dispatched ${installed.length} (worker finalises)` };
            },
          }
        : {}),
      warmCaches: async () => {
        // Migrations just created/changed DB-backed API routes (rows in
        // `api_routes`, including the public `/cms-api/v1/health` probe).
        // Clear the Redis-backed api-routes cache and rebuild the framework
        // cache, then restart the backend: it serves with FrankenPHP in
        // worker mode and compiled its router at boot (before migrations
        // ran), so the long-lived workers keep a stale router and every
        // freshly-migrated route 404s until the container is cycled. Wait for
        // the console to answer again so the health gate doesn't race the
        // reboot.
        await consoleExec(['cache:clear-api-routes']);
        await consoleExec(['cache:clear']);
        await deps.runner.run(paths.dir, ['restart', 'backend']);
        await waitForBackendConsole('Backend not ready after restart');
      },
      checkHealth: async () =>
        evaluateHealth(
          opts.instanceId,
          await deps.probeHealth(routing.publicFrontendUrl, routing.browserApiPrefix),
          deps.now,
        ),
      ...(opts.onStep ? { onPhase: (name: ProvisionStepName) => opts.onStep!(name) } : {}),
    },
  );
}

function pickCompatibleFrontend(core: CoreRelease, frontends: FrontendRelease[]): FrontendRelease | null {
  const candidates = frontends.filter((f) => {
    if (f.blocked) return false;
    const fInRange = semver.satisfies(semver.coerce(f.version) ?? '0.0.0', core.frontendCompatibility.requiredFrontendRange, { includePrerelease: true });
    const cInRange = semver.satisfies(semver.coerce(core.version) ?? '0.0.0', f.backendCompatibility.requiredCoreRange, { includePrerelease: true });
    return fInRange && cInRange;
  });
  return candidates.sort((a, b) => semver.rcompare(semver.coerce(a.version) ?? '0.0.0', semver.coerce(b.version) ?? '0.0.0'))[0] ?? null;
}

// ---------------------------------------------------------------------------
// instance health
// ---------------------------------------------------------------------------

export async function instanceHealth(deps: ActionDeps, instanceId: string): Promise<HealthReport> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const probes = await deps.probeHealth(manifest.routing.publicFrontendUrl, manifest.routing.browserApiPrefix);
  return evaluateHealth(instanceId, probes, deps.now);
}

// ---------------------------------------------------------------------------
// doctor (resource preflight)
// ---------------------------------------------------------------------------

export async function doctor(deps: ActionDeps, requiredPorts: number[]): Promise<ReturnType<typeof runPreflight>> {
  const facts = await deps.resourceFacts(requiredPorts);
  return runPreflight({
    instanceId: 'server',
    currentVersion: deps.managerVersion,
    targetVersion: deps.managerVersion,
    resources: facts,
    database: { migrationRange: '-', destructive: false, requiresBackup: false, manualConfirmationRequired: false },
  });
}

// ---------------------------------------------------------------------------
// instance update (dry-run + execute)
// ---------------------------------------------------------------------------

export interface InstanceUpdateOptions {
  dryRun?: boolean;
  channel?: ReleaseChannel;
  target?: string;
  acceptMigrationRisk?: boolean;
  /** Explicit opt-in for a one-way MySQL major-version upgrade required by the target core's runtime policy. */
  approveMysqlMajor?: boolean;
}

export async function instanceUpdate(deps: ActionDeps, instanceId: string, opts: InstanceUpdateOptions): Promise<{ plan: UpdatePlan; executed: boolean; report?: Awaited<ReturnType<typeof executeUpdate>> }> {
  const manifestStore = new ManifestStore(instanceId, deps.root);
  const manifest = await readManifestFriendly(deps, instanceId);
  const channel = opts.channel ?? manifest.registry.channel;
  const client = registryClient(deps, manifest.registry.url);
  const index = await client.getIndex();

  const coreReleases: CoreRelease[] = [];
  for (const ref of index.core.filter((r) => r.channel === channel && !r.blocked)) {
    coreReleases.push((await client.getCoreRelease(ref)).release);
  }
  const frontendReleases = await fetchAllFrontends(client, index.frontend, channel);
  const pluginReleases: PluginRelease[] = [];

  // An in-place update REUSES the running instance's already-bound ports (the
  // local published port, or the shared Traefik proxy's 80/443 in production) —
  // it never binds a NEW port. Requiring 80/443 to be FREE here wrongly blocks
  // every update on a host where something already holds them (Traefik itself in
  // production, or e.g. an OS service on a local/dev host), surfacing as a
  // `blocked` plan -> `executed: false`. Pass no required-free ports so the
  // disk/memory/cpu/docker preflight still runs without the spurious port gate.
  const facts = await deps.resourceFacts([]);
  const plan = planUpdate({
    instanceId,
    currentVersion: manifest.versions.selfhelp,
    channel,
    ...(opts.target ? { target: opts.target } : {}),
    coreReleases,
    frontendReleases,
    pluginReleases,
    installedPlugins: manifest.installedPlugins,
    resources: facts,
  });

  // Resolve the target runtime-service images from the target core's runtime
  // policy (falling back to the instance's current images) and surface the
  // MySQL major-upgrade decision ON THE PLAN — dry runs included — so callers,
  // the GUI update dialog in particular, can demand explicit approval before
  // executing. The MySQL data volume is always preserved (compose never runs
  // `down -v`), but a MySQL MAJOR upgrade is one-way.
  const currentRuntimeImages = {
    mysql: manifest.images.mysql,
    redis: manifest.images.redis,
    mercure: manifest.images.mercure,
  };
  const targetRuntimeImages = resolveTargetRuntimeImages(plan.core?.runtime, currentRuntimeImages);
  const mysqlUpgrade = evaluateMysqlMajorUpgrade(plan.core?.runtime, currentRuntimeImages.mysql, targetRuntimeImages.mysql);
  if (plan.core !== null) plan.mysqlMajor = mysqlUpgrade;

  if (opts.dryRun || plan.status === 'blocked' || plan.status === 'up_to_date' || plan.core === null || plan.frontend === null) {
    return { plan, executed: false };
  }

  // Defense-in-depth destructive guard. The backend rejects a destructive
  // migration without accepted risk before it ever dispatches the operation,
  // but the direct CLI path must refuse too: never mutate an instance for a
  // destructive migration unless the operator explicitly accepted the risk
  // (a verified backup is taken first regardless).
  if (plan.preflight?.database.destructive && !opts.acceptMigrationRisk) {
    plan.reasons.push(
      'Refusing a destructive migration without --accept-migration-risk; re-run with the flag once a verified backup exists.',
    );
    return { plan, executed: false };
  }

  const paths = instancePaths(instanceId, deps.root);
  const lockStore = new LockStore(instanceId, deps.root);
  const core = plan.core;
  const frontend = plan.frontend;

  // Backfill the per-instance manager token for instances installed before the
  // token existed: the update recreates the containers anyway, so the backend
  // picks up SELFHELP_MANAGER_TOKEN from the rewritten secrets.env and the
  // CMS<->Manager update loop becomes available. Minting is safe (the token
  // protects no persisted data); existing tokens are never changed.
  const onDiskSecrets = await readInstanceSecrets(paths.secretsDir);
  if (onDiskSecrets !== null) {
    const ensured = ensureManagerToken(onDiskSecrets);
    if (ensured.minted) {
      await writeInstanceSecrets(paths.secretsDir, ensured.secrets, deps.secretIO);
    }
  }

  // When the target core's policy demands it, refuse the one-way MySQL major
  // upgrade without an explicit operator opt-in (a verified backup is taken
  // first regardless). The decision itself was computed above, pre-dry-run.
  if (mysqlUpgrade.requiresApproval && !opts.approveMysqlMajor) {
    plan.reasons.push(
      `Refusing MySQL major upgrade ${mysqlUpgrade.fromMajor} -> ${mysqlUpgrade.toMajor} without --approve-mysql-major (GUI: the "Approve MySQL major upgrade" checkbox). ` +
        'The data volume is preserved, but a major MySQL upgrade is one-way; take a verified backup, then re-run with the flag.',
    );
    return { plan, executed: false };
  }
  const services = await deps.resolveServiceDigests(targetRuntimeImages);

  // Pre-update snapshot captured by the executor before any mutation. It holds
  // the previous compose/env/readme text plus the manifest + lock (which pin the
  // previous image digests + migration head), so a pre-migration failure can be
  // restored exactly and the previous containers brought back up.
  let preUpdateSnapshot:
    | { compose: string; env: string; readme: string; manifest: InstanceManifest; lock: InstanceLock }
    | null = null;

  const report = await executeUpdate(
    { instanceId, targetVersion: plan.targetVersion!, preflightId: `cli-${Date.now()}`, approvedByUserId: 0, audit: { at: deps.now?.() ?? new Date().toISOString(), actorUserId: 0, requestedInstanceId: instanceId, trustedInstanceId: instanceId, allowed: true, reason: 'cli operator' } },
    plan,
    {
      runner: deps.runner,
      instanceDir: paths.dir,
      // Real backup before any mutation. executeUpdate aborts (no rollback)
      // when this throws, so a failed backup safely stops the update.
      takeBackup: async () => {
        const backup = await instanceBackup(deps, instanceId, { mode: 'maintenance' });
        return { backupId: backup.backupId };
      },
      // Capture the previous config + lock/manifest before applyArtifacts
      // overwrites them, so rollback can restore the exact prior state.
      snapshot: async () => {
        preUpdateSnapshot = {
          compose: await readFile(paths.composePath, 'utf8').catch(() => ''),
          env: await readFile(paths.envPath, 'utf8').catch(() => ''),
          readme: await readFile(paths.readmePath, 'utf8').catch(() => ''),
          manifest: await manifestStore.read(),
          lock: await lockStore.read(),
        };
      },
      applyArtifacts: async () => {
        const artifacts = buildInstanceInstallArtifacts({
          instanceId,
          displayName: manifest.displayName,
          mode: manifest.mode,
          // Local-mode instances pin a published `localPort` (recoverable from the
          // manifest's `http://localhost:<port>` public URL); production pins a
          // `domain`. The compose/url builders REQUIRE the mode-appropriate value,
          // so an update must forward it or `buildInstanceInstallArtifacts` aborts
          // with "Local install requires a localPort." (regressed local updates).
          ...(manifest.mode === 'production'
            ? { domain: manifest.domain }
            : { localPort: Number(new URL(manifest.routing.publicFrontendUrl).port) }),
          root: deps.root,
          ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
          managerVersion: deps.managerVersion,
          channel,
          registry: { id: manifest.registry.id, url: manifest.registry.url, metadataSha256: client.lastSuccessfulCheck?.metadataSha256 ?? '' },
          core,
          frontend,
          services,
          installedPlugins: manifest.installedPlugins,
        });
        await writeFileAtomic(paths.composePath, artifacts.composeYaml);
        await writeFileAtomic(paths.envPath, artifacts.envText);
        await writeFileAtomic(paths.readmePath, artifacts.readme);
        await manifestStore.write({ ...artifacts.manifest, createdAt: manifest.createdAt, updatedAt: deps.now?.() ?? new Date().toISOString() });
        await lockStore.write(artifacts.lock);
      },
      runMigrations: async () => {
        await deps.runner.run(paths.dir, ['exec', '-T', 'backend', 'php', 'bin/console', 'doctrine:migrations:migrate', '--no-interaction', '--allow-no-migration']);
      },
      checkHealth: async () => evaluateHealth(instanceId, await deps.probeHealth(manifest.routing.publicFrontendUrl, manifest.routing.browserApiPrefix), deps.now),
      // Effective rollback: restore the pre-update compose/env/readme + manifest
      // + lock (previous image digests/migration head) captured by snapshot(),
      // then recreate the previous containers. Data is only safe when migrations
      // did not run; executeUpdate flags requiresManualRestore otherwise.
      rollback: async () => {
        if (preUpdateSnapshot) {
          const snap = preUpdateSnapshot;
          if (snap.compose) await writeFileAtomic(paths.composePath, snap.compose);
          if (snap.env) await writeFileAtomic(paths.envPath, snap.env);
          if (snap.readme) await writeFileAtomic(paths.readmePath, snap.readme);
          await manifestStore.write(snap.manifest);
          await lockStore.write(snap.lock);
        }
        await deps.runner.run(paths.dir, composeCommands.upDetached());
      },
      // Maintenance window: the backend returns a clean 503 to normal traffic
      // while the stack is replaced. The backend stays up to serve that 503 (and
      // the Manager loop / health / auth / admin.system routes); only the traffic
      // producers are stopped.
      enterMaintenance: async () => {
        await deps.runner.run(paths.dir, [
          'exec', '-T', 'backend', 'php', 'bin/console', 'selfhelp:maintenance',
          '--enable', `--message=Updating to ${plan.targetVersion}`, '--actor=sh-manager',
        ]);
      },
      exitMaintenance: async () => {
        await deps.runner.run(paths.dir, [
          'exec', '-T', 'backend', 'php', 'bin/console', 'selfhelp:maintenance', '--disable', '--actor=sh-manager',
        ]);
      },
      stopServices: async (names) => {
        await deps.runner.run(paths.dir, [...composeCommands.stop(), ...names]);
      },
    },
  );

  return { plan, executed: true, report };
}

// ---------------------------------------------------------------------------
// CMS <-> Manager update loop (consume backend-requested operations)
// ---------------------------------------------------------------------------

/**
 * Builds the executor that the operations consumer runs for an approved update.
 * It reuses the same resolve+execute machinery as {@link instanceUpdate} and
 * streams coarse lifecycle phases back through `phase(...)`. A blocked /
 * up-to-date plan is surfaced as a failed report so the loop writes it back
 * instead of silently doing nothing.
 */
export function buildOperationExecutor(deps: ActionDeps): OperationExecutor {
  return async (approved, op, phase) => {
    await phase('preflight_running', 10, `Resolving update to ${op.targetVersion}.`);
    await phase('backup_running', 25);

    const res = await instanceUpdate(deps, approved.instanceId, {
      target: op.targetVersion,
      acceptMigrationRisk: op.acceptedMigrationRisk,
    });

    if (!res.executed || !res.report) {
      return {
        instanceId: approved.instanceId,
        targetVersion: op.targetVersion,
        ok: false,
        rolledBack: false,
        steps: [{ name: 'plan', status: 'failed', detail: `plan status: ${res.plan.status}` }],
      };
    }

    await phase('health_check_running', 90);
    return res.report;
  };
}

/**
 * Claims and processes the next pending CMS-requested operation for an
 * instance. The trusted instance id is taken from the server-side manifest, and
 * the authenticated {@link BackendOperationsClient} is injected so the transport
 * is testable.
 */
export async function processInstanceOperations(
  deps: ActionDeps,
  instanceId: string,
  client: BackendOperationsClient,
): Promise<ProcessOutcome> {
  const manifest = await readManifestFriendly(deps, instanceId);
  return processNextOperation({
    trustedInstanceId: manifest.instanceId,
    client,
    execute: buildOperationExecutor(deps),
    ...(deps.now ? { now: deps.now } : {}),
  });
}

/**
 * Drains every pending CMS-requested operation for an instance in a single
 * invocation (claim → execute → write-back, repeated until the backend is idle).
 * A supervised trigger (systemd service / cron) calls this each tick so requests
 * never stay on "requested".
 */
export async function drainInstanceOperations(
  deps: ActionDeps,
  instanceId: string,
  client: BackendOperationsClient,
): Promise<ProcessOutcome[]> {
  const manifest = await readManifestFriendly(deps, instanceId);
  return drainOperations({
    trustedInstanceId: manifest.instanceId,
    client,
    execute: buildOperationExecutor(deps),
    ...(deps.now ? { now: deps.now } : {}),
  });
}

// ---------------------------------------------------------------------------
// shared helpers (backup / restore / support)
// ---------------------------------------------------------------------------

function sha256Hex(buf: Buffer): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

/** Minimal `.env` parser (KEY=VALUE, ignores comments/blank lines, strips quotes). */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

async function hashFilesIn(dir: string, exclude: string[]): Promise<{ path: string; sha256: string; bytes: number }[]> {
  const names = (await readdir(dir)).filter((n) => !exclude.includes(n)).sort();
  const out: { path: string; sha256: string; bytes: number }[] = [];
  for (const name of names) {
    const buf = await readFile(path.join(dir, name));
    out.push({ path: name, sha256: sha256Hex(buf), bytes: buf.length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// instance backup
// ---------------------------------------------------------------------------

export interface BackupOptions {
  mode?: 'maintenance' | 'online';
  seq?: number;
}

/**
 * Creates a consistent, checksummed backup under
 * `/opt/selfhelp/instances/<id>/backups/<backupId>/`: a MySQL dump, manifest +
 * lock snapshots, a redacted env copy, the compose file, and (when volume
 * archiving is available) uploads + plugin-artifact archives. A backup manifest
 * with per-file checksums is written last so it never hashes itself.
 */
export async function instanceBackup(
  deps: ActionDeps,
  instanceId: string,
  opts: BackupOptions = {},
): Promise<{ backupId: string; backupDir: string; manifest: BackupManifest }> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const lock = await new LockStore(instanceId, deps.root).read();
  const paths = instancePaths(instanceId, deps.root);
  const project = composeProjectName(instanceId);

  const createdAt = deps.now?.() ?? new Date().toISOString();
  const seq = opts.seq ?? 1;
  const backupId = makeBackupId(instanceId, new Date(createdAt), seq);
  const backupDir = path.join(paths.backupsDir, backupId);
  await mkdir(backupDir, { recursive: true });

  const includedAreas = ['database', 'manifest', 'lock'];

  // 1. Database dump (maintenance-mode default; mysqldump runs in the db container).
  const { stdout: dump } = await deps.runner.run(paths.dir, ['exec', '-T', 'mysql', 'sh', '-lc', APP_DB_DUMP_CMD]);
  await writeFile(path.join(backupDir, 'database.sql'), dump);

  // 2. Metadata snapshots (manifest + lock + redacted env + compose copy).
  await writeFile(path.join(backupDir, 'selfhelp.instance.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(backupDir, 'selfhelp.lock.json'), JSON.stringify(lock, null, 2));
  const envText = await readFile(paths.envPath, 'utf8').catch(() => '');
  if (envText) {
    const redacted = Object.entries(redactEnv(parseEnv(envText)))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    await writeFile(path.join(backupDir, 'env.redacted'), redacted);
  }
  const composeText = await readFile(paths.composePath, 'utf8').catch(() => '');
  if (composeText) await writeFile(path.join(backupDir, 'compose.yaml'), composeText);

  // 3. Persistent volume archives (uploads + plugin artifacts) when available.
  // The backend writes plugin data to two container paths, each backed by its
  // own named volume, so both are archived under the single plugin_artifacts
  // area (REQUIRED_BACKUP_AREAS stays unchanged; the extra .tgz is still
  // checksummed by the backup manifest below).
  if (deps.archiveVolume) {
    await deps.archiveVolume(`${project}_uploads`, path.join(backupDir, 'uploads.tgz'));
    includedAreas.push('uploads');
    await deps.archiveVolume(`${project}_plugin_artifacts`, path.join(backupDir, 'plugin_artifacts.tgz'));
    await deps.archiveVolume(
      `${project}_plugin_artifacts_public`,
      path.join(backupDir, 'plugin_artifacts_public.tgz'),
    );
    includedAreas.push('plugin_artifacts');
  }

  const files = await hashFilesIn(backupDir, ['backup-manifest.json']);
  const backupManifest = buildBackupManifest({
    instanceId,
    selfhelpVersion: manifest.versions.selfhelp,
    migrationVersion: lock.core.migrationVersion,
    plugins: manifest.installedPlugins,
    mode: opts.mode,
    includedAreas,
    files,
    createdAt,
    seq,
  });
  await writeFile(path.join(backupDir, 'backup-manifest.json'), JSON.stringify(backupManifest, null, 2));

  return { backupId, backupDir, manifest: backupManifest };
}

// ---------------------------------------------------------------------------
// instance restore (validate + plan; never destructive by itself)
// ---------------------------------------------------------------------------

export interface RestoreCliOptions {
  mode?: RestoreMode;
  preserveSecrets?: boolean;
  newDomain?: string;
  disasterRecoveryImport?: boolean;
  /** When true, materialize the restore's secret policy on disk (else plan only). */
  apply?: boolean;
}

export async function instanceRestore(
  deps: ActionDeps,
  instanceId: string,
  backupId: string,
  opts: RestoreCliOptions = {},
): Promise<{
  validation: BackupValidation;
  plan: RestorePlan | null;
  backupDir: string;
  executed?: boolean;
  secretsRegenerated?: boolean;
  secretsWritten?: string[];
  migrated?: boolean;
  health?: HealthReport;
}> {
  const paths = instancePaths(instanceId, deps.root);
  const lockStore = new LockStore(instanceId, deps.root);
  const manifestStore = new ManifestStore(instanceId, deps.root);
  const project = composeProjectName(instanceId);
  const backupDir = path.join(paths.backupsDir, backupId);
  const raw = await readFile(path.join(backupDir, 'backup-manifest.json'), 'utf8').catch(() => null);
  if (raw === null) {
    return {
      validation: { ok: false, errors: [`Backup "${backupId}" not found under ${paths.backupsDir}.`] },
      plan: null,
      backupDir,
    };
  }
  const backupManifest = JSON.parse(raw) as BackupManifest;

  // Recompute hashes for integrity verification.
  const actualHashes: Record<string, string> = {};
  for (const f of backupManifest.files) {
    const buf = await readFile(path.join(backupDir, f.path)).catch(() => null);
    if (buf) actualHashes[f.path] = sha256Hex(buf);
  }

  const req: RestoreRequest = {
    targetInstanceId: instanceId,
    backupId,
    mode: opts.mode ?? 'same_instance',
    preserveSecrets: opts.preserveSecrets,
    newDomain: opts.newDomain,
    disasterRecoveryImport: opts.disasterRecoveryImport,
  };

  const validation = validateBackupForRestore(req, backupManifest, [...REQUIRED_BACKUP_AREAS], actualHashes);
  const plan = validation.ok ? planRestore(req, backupManifest) : null;

  if (!(opts.apply && plan && validation.ok)) {
    return { validation, plan, backupDir };
  }

  // --- Execute the restore. Never destructive to volumes: `compose stop`
  // (never `-v`), import the DB dump, extract the upload/plugin archives, then
  // bring the stack back up on the restored data.
  if (!deps.importDatabase || !deps.extractVolume) {
    throw new Error('Applying a restore requires the importDatabase + extractVolume host helpers.');
  }
  const isClone = req.mode === 'restore_as_clone';

  // Secret policy: a same-instance restore preserves the existing on-disk
  // secrets (the data they protect is unchanged); a restore-as-clone is a new
  // security boundary and MUST get fresh secrets that share nothing with the source.
  let secretsRegenerated = false;
  let secretsWritten: string[] | undefined;
  if (isClone) {
    const { secrets } = secretsForRestore('restore_as_clone', undefined, secretGenOptions(deps));
    secretsWritten = await writeInstanceSecrets(paths.secretsDir, secrets, deps.secretIO);
    secretsRegenerated = true;
  }

  // Migration head currently expected by the running code (before we restore the
  // lock), used to decide whether a forward migration is required.
  const preRestoreHead = await lockStore
    .read()
    .then((l) => l.core.migrationVersion)
    .catch(() => undefined);

  // Point-in-time manifest + lock captured in the backup.
  const restoredManifest = JSON.parse(
    await readFile(path.join(backupDir, 'selfhelp.instance.json'), 'utf8'),
  ) as InstanceManifest;
  const restoredLock = JSON.parse(
    await readFile(path.join(backupDir, 'selfhelp.lock.json'), 'utf8'),
  ) as InstanceLock;
  restoredManifest.instanceId = instanceId;
  restoredManifest.updatedAt = deps.now?.() ?? new Date().toISOString();

  // 1. Quiesce the instance, keeping every volume.
  await deps.runner.run(paths.dir, composeCommands.stop());

  // 2. Restore persistent volumes from the backup archives (when present).
  const uploadsTgz = path.join(backupDir, 'uploads.tgz');
  if (await pathExists(uploadsTgz)) await deps.extractVolume(uploadsTgz, `${project}_uploads`);
  const pluginTgz = path.join(backupDir, 'plugin_artifacts.tgz');
  if (await pathExists(pluginTgz)) await deps.extractVolume(pluginTgz, `${project}_plugin_artifacts`);
  const pluginPublicTgz = path.join(backupDir, 'plugin_artifacts_public.tgz');
  if (await pathExists(pluginPublicTgz)) {
    await deps.extractVolume(pluginPublicTgz, `${project}_plugin_artifacts_public`);
  }

  // 3. Start MySQL only, wait until ready, import the database dump.
  await deps.runner.run(paths.dir, [...composeCommands.upDetached(), 'mysql']);
  await waitForMysqlReady(deps, paths.dir);
  await deps.importDatabase(paths.dir, path.join(backupDir, 'database.sql'));

  // 4. Restore configuration. A same-instance restore re-applies the point-in-time
  // compose (so code matches the restored DB). A clone/DR import keeps the current
  // code (so an older DB can be migrated forward) and rebuilds routing/compose for
  // its new production domain when one was given.
  let restoreCompose = false;
  if (isClone && opts.newDomain && restoredManifest.mode === 'production') {
    restoredManifest.domain = opts.newDomain;
    const publicFrontendUrl = `https://${opts.newDomain}`;
    restoredManifest.routing = buildInstanceRouting({
      instanceId,
      mode: 'production',
      selfhelpVersion: restoredManifest.versions.selfhelp,
      frontendVersion: restoredManifest.versions.frontend,
      publicFrontendUrl,
    });
    await writeFileAtomic(
      paths.composePath,
      generateInstanceComposeYaml({
        instanceId,
        mode: 'production',
        images: restoredManifest.images,
        domain: opts.newDomain,
        ...(restoredManifest.resources ? { resources: restoredManifest.resources } : {}),
        ...(deps.engineRoot
          ? { hostBindDir: toEnginePath(paths.dir, { containerRoot: deps.root, engineRoot: deps.engineRoot }) }
          : {}),
      }),
    );
  } else if (!isClone) {
    const composeBackup = await readFile(path.join(backupDir, 'compose.yaml'), 'utf8').catch(() => '');
    if (composeBackup) {
      await writeFileAtomic(paths.composePath, composeBackup);
      restoreCompose = true;
    }
  }

  // 5. Persist the restored manifest + lock + inventory entry.
  await manifestStore.write(restoredManifest);
  await lockStore.write(restoredLock);
  await new InventoryStore(deps.root).upsertInstance({
    instanceId,
    domain: restoredManifest.domain,
    path: paths.dir,
    composeProject: project,
    status: 'active',
  });

  // 6. Bring the full stack up on the restored data.
  await deps.runner.run(paths.dir, composeCommands.upDetached());

  // 7. Migrate only when needed: the restored DB head differs from the running
  // code's head (i.e. current code was kept rather than the backup's compose).
  const restoredHead = restoredLock.core.migrationVersion;
  const migrated = !restoreCompose && preRestoreHead !== undefined && restoredHead !== preRestoreHead;
  if (migrated) {
    await deps.runner.run(paths.dir, [
      'exec',
      '-T',
      'backend',
      'php',
      'bin/console',
      'doctrine:migrations:migrate',
      '--no-interaction',
      '--allow-no-migration',
    ]);
  }

  // 8. Health.
  const health = evaluateHealth(
    instanceId,
    await deps.probeHealth(restoredManifest.routing.publicFrontendUrl, restoredManifest.routing.browserApiPrefix),
    deps.now,
  );

  return {
    validation,
    plan,
    backupDir,
    executed: true,
    secretsRegenerated,
    ...(secretsWritten ? { secretsWritten } : {}),
    migrated,
    health,
  };
}

// ---------------------------------------------------------------------------
// instance clone (plan)
// ---------------------------------------------------------------------------

/**
 * Synthesises the minimal core/frontend release shapes the artifact builder
 * needs from an instance's manifest + lock — for offline operations (clone,
 * address change) that must pin the EXACT versions/digests already installed
 * instead of consulting the registry.
 */
function releaseShapesFromLock(
  manifest: InstanceManifest,
  lock: InstanceLock,
  keyId: string,
): { core: CoreRelease; frontend: FrontendRelease } {
  const channel = manifest.registry.channel;
  const core: CoreRelease = {
    kind: 'selfhelp-core-release',
    id: `selfhelp-core-${lock.core.version}`,
    version: lock.core.version,
    channel,
    releasedAt: lock.generatedAt,
    minimumDirectUpgradeFrom: lock.core.version,
    pluginApiVersion: lock.core.pluginApiVersion,
    backend: { image: manifest.images.backend, digest: lock.core.backendImageDigest },
    worker: { image: manifest.images.worker, digest: lock.core.workerImageDigest },
    scheduler: { image: manifest.images.scheduler, digest: lock.core.schedulerImageDigest },
    frontendCompatibility: { requiredFrontendRange: '*' },
    database: {
      migrationRange: lock.core.migrationVersion,
      destructive: false,
      requiresBackup: false,
      manualConfirmationRequired: false,
    },
    security: {
      signature: lock.core.signedPayloadSha256,
      keyId,
      signedPayloadSha256: lock.core.signedPayloadSha256,
    },
  };
  const frontend: FrontendRelease = {
    kind: 'selfhelp-frontend-release',
    id: `selfhelp-frontend-${manifest.versions.frontend}`,
    version: manifest.versions.frontend,
    channel,
    image: manifest.images.frontend,
    digest: lock.core.frontendImageDigest,
    backendCompatibility: { requiredCoreRange: '*', requiredApiVersion: lock.core.pluginApiVersion },
    security: { signature: lock.core.signedPayloadSha256, keyId },
  };
  return { core, frontend };
}

export interface CloneCliOptions {
  /** Production clones: the clone's new public domain. */
  targetDomain?: string;
  /** Local-mode clones need their own published localhost port. */
  targetLocalPort?: number;
  preserveVersions?: boolean;
  copyUploads?: boolean;
  copyPluginArtifacts?: boolean;
  /** When true, build + populate the clone (else plan only). */
  apply?: boolean;
}

export async function instanceClone(
  deps: ActionDeps,
  sourceInstanceId: string,
  targetInstanceId: string,
  opts: CloneCliOptions,
): Promise<{ plan: ClonePlan; executed?: boolean; secretsWritten?: string[]; health?: HealthReport }> {
  const sourceManifest = await readManifestFriendly(deps, sourceInstanceId);
  const sourceLock = await new LockStore(sourceInstanceId, deps.root).read();
  const mode = sourceManifest.mode;
  // Mode-aware address requirement: a production clone routes a NEW domain; a
  // local clone publishes a NEW localhost port (its inventory "domain" is
  // localhost:<port>). Validated before planning so plan-only calls fail fast.
  if (mode === 'local' && opts.targetLocalPort === undefined) {
    throw new Error('Cloning a local instance requires a target local port (--target-local-port).');
  }
  if (mode === 'production' && !opts.targetDomain) {
    throw new Error('Cloning a production instance requires a target domain (--target-domain).');
  }
  const targetDomain = mode === 'production' ? opts.targetDomain! : `localhost:${opts.targetLocalPort}`;
  const req: CloneRequest = {
    sourceInstanceId,
    targetInstanceId,
    targetDomain,
    preserveVersionsFromLock: opts.preserveVersions ?? true,
    generateNewSecrets: true,
    copyUploads: opts.copyUploads ?? true,
    copyPluginArtifacts: opts.copyPluginArtifacts ?? true,
    sourceDomain: sourceManifest.domain,
  };
  const plan = planClone(req, sourceLock);

  if (!opts.apply) {
    return { plan };
  }

  // --- Execute the clone. The source is read-only throughout (mysqldump +
  // read-only volume copies); it is never stopped or recreated. ---
  if (!deps.copyVolume || !deps.importDatabase) {
    throw new Error('Applying a clone requires the copyVolume + importDatabase host helpers.');
  }

  const sourcePaths = instancePaths(sourceInstanceId, deps.root);
  const targetPaths = instancePaths(targetInstanceId, deps.root);
  const sourceProject = composeProjectName(sourceInstanceId);
  const targetProject = composeProjectName(targetInstanceId);
  const channel = sourceManifest.registry.channel;

  // Pin the clone to the SOURCE lock's versions + image digests so it runs
  // exactly the source's images.
  const { core, frontend } = releaseShapesFromLock(sourceManifest, sourceLock, 'cloned');

  const artifacts = buildInstanceInstallArtifacts({
    instanceId: targetInstanceId,
    displayName: sourceManifest.displayName,
    mode,
    ...(mode === 'production' ? { domain: opts.targetDomain } : { localPort: opts.targetLocalPort }),
    root: deps.root,
    ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
    managerVersion: deps.managerVersion,
    channel,
    registry: {
      id: sourceManifest.registry.id,
      url: sourceManifest.registry.url,
      metadataSha256: sourceLock.registry.metadataSha256,
    },
    core,
    frontend,
    services: sourceLock.services,
    installedPlugins: sourceManifest.installedPlugins,
    pluginLock: sourceLock.plugins,
    ...(sourceManifest.resources ? { resources: sourceManifest.resources } : {}),
  });

  // A clone is a distinct security boundary: generate fresh secrets that share
  // nothing with the source, write the target artifacts + inventory entry, but
  // do not bring it up yet (we populate volumes + DB first).
  const secrets = generateCloneSecrets(secretGenOptions(deps));
  const secretsWritten = await writeInstanceSecrets(targetPaths.secretsDir, secrets, deps.secretIO);
  await installInstance(artifacts, {
    root: deps.root,
    runner: deps.runner,
    bringUp: false,
    secrets,
    secretIO: deps.secretIO,
  });

  // Copy persistent volumes from the source (read-only) into the new target volumes.
  if (plan.copyUploads) await deps.copyVolume(`${sourceProject}_uploads`, `${targetProject}_uploads`);
  if (plan.copyPluginArtifacts) {
    await deps.copyVolume(`${sourceProject}_plugin_artifacts`, `${targetProject}_plugin_artifacts`);
    await deps.copyVolume(
      `${sourceProject}_plugin_artifacts_public`,
      `${targetProject}_plugin_artifacts_public`,
    );
  }

  // Bring up the clone's MySQL, then copy the database from the (untouched)
  // source via a read-only dump piped into the clone.
  await deps.runner.run(targetPaths.dir, [...composeCommands.upDetached(), 'mysql']);
  await waitForMysqlReady(deps, targetPaths.dir);
  const { stdout: dump } = await deps.runner.run(sourcePaths.dir, ['exec', '-T', 'mysql', 'sh', '-lc', APP_DB_DUMP_CMD]);
  await mkdir(targetPaths.backupsDir, { recursive: true });
  const tmpDump = path.join(targetPaths.backupsDir, 'clone-source.sql');
  await writeFile(tmpDump, dump);
  await deps.importDatabase(targetPaths.dir, tmpDump);
  await rm(tmpDump, { force: true });

  // Bring the full clone stack up and health-check it.
  await deps.runner.run(targetPaths.dir, composeCommands.upDetached());
  const health = evaluateHealth(
    targetInstanceId,
    await deps.probeHealth(artifacts.manifest.routing.publicFrontendUrl, artifacts.manifest.routing.browserApiPrefix),
    deps.now,
  );

  return { plan, executed: true, secretsWritten, health };
}

// ---------------------------------------------------------------------------
// instance set-address (change production domain / local port, then restart)
// ---------------------------------------------------------------------------

export interface SetAddressOptions {
  /** Production instances: the new public domain. */
  domain?: string;
  /** Local instances: the new published localhost port. */
  localPort?: number;
  /** Recreate the containers so the new address takes effect (default true). */
  restart?: boolean;
  /** Production: block (not just warn) when DNS does not resolve to this server. */
  strictDns?: boolean;
}

export interface SetAddressResult {
  changed: boolean;
  previousDomain: string;
  domain: string;
  publicUrl: string;
  warnings: string[];
  restarted: boolean;
  health?: HealthReport;
}

/**
 * Changes where an instance is reachable — the routed domain (production) or
 * the published localhost port (local) — by regenerating the instance's
 * compose/.env/manifest/README from the pinned lock versions and recreating
 * the containers. The mode itself never changes here.
 *
 * Re-applying the CURRENT address is intentionally allowed: it regenerates the
 * runtime config from the lock and restarts, which is also the documented way
 * to roll out manager-side config fixes (e.g. Mercure routing) to an existing
 * instance without an update.
 */
export async function instanceSetAddress(
  deps: ActionDeps,
  instanceId: string,
  opts: SetAddressOptions,
): Promise<SetAddressResult> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const lockStore = new LockStore(instanceId, deps.root);
  const lock = await lockStore.read();
  const mode = manifest.mode;

  if (mode === 'production' && !opts.domain) {
    throw new Error('Changing a production instance address requires --domain.');
  }
  if (mode === 'local' && opts.localPort === undefined) {
    throw new Error('Changing a local instance address requires --port.');
  }
  if (mode === 'local' && (!Number.isInteger(opts.localPort) || opts.localPort! < 1 || opts.localPort! > 65535)) {
    throw new Error('Local port must be an integer between 1 and 65535.');
  }

  // Same duplicate-domain / DNS-binding rules as an install; the instance's
  // own current claim is excluded so re-applying the same address is valid.
  const warnings = await assertInstallableDomain(deps, {
    instanceId,
    mode,
    ...(mode === 'production' ? { domain: opts.domain! } : { localPort: opts.localPort! }),
    ...(opts.strictDns !== undefined ? { strictDns: opts.strictDns } : {}),
  });

  const newDomain = mode === 'production' ? opts.domain! : `localhost:${opts.localPort}`;
  const previousDomain = manifest.domain;
  const changed = newDomain !== previousDomain;

  // Regenerate compose/.env/README/manifest with the pinned lock versions —
  // never the registry — so an address change can run fully offline and can
  // never bump code. The lock itself is NOT rewritten (versions are unchanged).
  const { core, frontend } = releaseShapesFromLock(manifest, lock, 'address-change');
  const paths = instancePaths(instanceId, deps.root);
  const artifacts = buildInstanceInstallArtifacts({
    instanceId,
    displayName: manifest.displayName,
    mode,
    ...(mode === 'production' ? { domain: opts.domain! } : { localPort: opts.localPort! }),
    root: deps.root,
    ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
    managerVersion: deps.managerVersion,
    channel: manifest.registry.channel,
    registry: { id: lock.registry.id, url: lock.registry.url, metadataSha256: lock.registry.metadataSha256 },
    core,
    frontend,
    services: lock.services,
    installedPlugins: manifest.installedPlugins,
    pluginLock: lock.plugins,
    ...(manifest.resources ? { resources: manifest.resources } : {}),
  });
  await writeFileAtomic(paths.composePath, artifacts.composeYaml);
  await writeFileAtomic(paths.envPath, artifacts.envText);
  await writeFileAtomic(paths.readmePath, artifacts.readme);
  await new ManifestStore(instanceId, deps.root).write({
    ...artifacts.manifest,
    createdAt: manifest.createdAt,
    updatedAt: deps.now?.() ?? new Date().toISOString(),
  });

  // Reflect the new address in the server inventory (domain is the routing key).
  const inventoryStore = new InventoryStore(deps.root);
  const inventory = await inventoryStore.read().catch(() => null);
  if (inventory) {
    const entry = inventory.instances.find((e) => e.instanceId === instanceId);
    if (entry) {
      entry.domain = newDomain;
      await inventoryStore.write(inventory);
    }
  }

  const restart = opts.restart ?? true;
  let health: HealthReport | undefined;
  if (restart) {
    // The compose declares the shared proxy network as external; make sure it
    // exists even on servers bootstrapped before multi-instance support.
    if (deps.ensureNetwork) {
      const network = inventory?.proxy.network ?? DEFAULT_PROXY_NETWORK;
      await deps.ensureNetwork(network);
    }
    await deps.runner.run(paths.dir, composeCommands.upDetached());
    health = evaluateHealth(
      instanceId,
      await deps.probeHealth(artifacts.manifest.routing.publicFrontendUrl, artifacts.manifest.routing.browserApiPrefix),
      deps.now,
    );
  }

  return {
    changed,
    previousDomain,
    domain: newDomain,
    publicUrl: artifacts.manifest.routing.publicFrontendUrl,
    warnings,
    restarted: restart,
    ...(health ? { health } : {}),
  };
}

// ---------------------------------------------------------------------------
// instance remove (disable / remove-keep-data / full-delete)
// ---------------------------------------------------------------------------

export interface RemoveOptions {
  mode: RemoveMode;
  deleteVolumes?: boolean;
  deleteBackups?: boolean;
  confirm?: string;
}

export async function instanceRemove(
  deps: ActionDeps,
  instanceId: string,
  opts: RemoveOptions,
): Promise<RemovePlan & { executed: boolean }> {
  const store = new InventoryStore(deps.root);
  const inventory = await store.read();
  const plan = planRemove(
    {
      instanceId,
      mode: opts.mode,
      deleteVolumes: opts.deleteVolumes,
      deleteBackups: opts.deleteBackups,
      typedConfirmation: opts.confirm,
    },
    inventory,
    deps.root,
  );
  if (!plan.ok) return { ...plan, executed: false };

  const paths = instancePaths(instanceId, deps.root);

  // 1. Compose command (stop/down — never `-v`).
  await deps.runner.run(paths.dir, plan.composeArgs);

  // 2. full_delete: remove this instance's volumes + folder.
  if (plan.deleteVolumes.length > 0) {
    if (!deps.removeVolumes) {
      throw new Error('Volume removal is not available in this manager environment.');
    }
    await deps.removeVolumes(plan.deleteVolumes);
  }
  if (plan.deleteInstanceDir) {
    if (plan.preserveBackups) {
      for (const name of await readdir(paths.dir).catch(() => [] as string[])) {
        if (path.join(paths.dir, name) === paths.backupsDir) continue;
        await rm(path.join(paths.dir, name), { recursive: true, force: true });
      }
    } else {
      await rm(paths.dir, { recursive: true, force: true });
    }
  }

  // 3. Inventory mutation.
  if (plan.removeInventoryEntry) {
    inventory.instances = inventory.instances.filter((i) => i.instanceId !== instanceId);
    await store.write(inventory);
  } else if (plan.newStatus) {
    const entry = inventory.instances.find((i) => i.instanceId === instanceId);
    if (entry) {
      entry.status = plan.newStatus;
      await store.write(inventory);
    }
  }

  return { ...plan, executed: true };
}

// ---------------------------------------------------------------------------
// instance support-bundle (redacted)
// ---------------------------------------------------------------------------

export async function instanceSupportBundle(
  deps: ActionDeps,
  instanceId: string,
): Promise<{ dir: string; files: string[] }> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const lock = await new LockStore(instanceId, deps.root).read();
  const paths = instancePaths(instanceId, deps.root);

  const env = parseEnv(await readFile(paths.envPath, 'utf8').catch(() => ''));

  const composeStatus = await deps.runner
    .run(paths.dir, composeCommands.ps())
    .then((r) => r.stdout)
    .catch(() => '');
  const logs: { backend?: string; frontend?: string; scheduler?: string; worker?: string } = {};
  for (const svc of ['backend', 'frontend', 'scheduler', 'worker'] as const) {
    logs[svc] = await deps.runner
      .run(paths.dir, [...composeCommands.logs(), svc])
      .then((r) => r.stdout)
      .catch(() => '');
  }

  const bundle = assembleSupportBundle({
    instanceId,
    managerVersion: deps.managerVersion,
    schemaVersions: { manifest: manifest.manifestVersion, lock: lock.lockfileVersion, inventory: 1 },
    manifest,
    lock,
    versionSummary: {
      selfhelp: manifest.versions.selfhelp,
      backend: manifest.versions.backend,
      frontend: manifest.versions.frontend,
      migrationVersion: lock.core.migrationVersion,
    },
    installedPlugins: manifest.installedPlugins,
    env,
    healthResults: {},
    composeStatus,
    logs,
  });

  const stamp = (deps.now?.() ?? new Date().toISOString()).replace(/[:.]/g, '-');
  const dir = path.join(paths.logsDir, `support-bundle-${stamp}`);
  await mkdir(dir, { recursive: true });
  for (const f of bundle.files) await writeFile(path.join(dir, f.name), f.content);

  return { dir, files: bundle.files.map((f) => f.name) };
}

// ---------------------------------------------------------------------------
// instance repair (reconstruct a missing/invalid manifest)
// ---------------------------------------------------------------------------

export interface RepairOutcome {
  repaired: boolean;
  /** Where the manifest came from: already valid, a backup snapshot, or rebuilt. */
  source: 'intact' | 'backup' | 'reconstructed';
  manifestPath: string;
  notes: string[];
}

/**
 * Repairs an instance whose `selfhelp.instance.json` is missing or invalid
 * (the "instance is gone" failure). Sources, in order of fidelity:
 *
 * 1. Intact manifest → only re-register a missing inventory entry.
 * 2. The newest backup's manifest snapshot (every backup stores a full copy).
 * 3. Reconstruction from inventory entry + lock file + compose file (versions
 *    from the lock, images/mode/port from compose, domain from the inventory).
 *
 * Never touches containers, volumes or backups. Secrets are only ever
 * extended: a missing per-instance manager token is minted (same backfill as
 * `instanceUpdate`); existing secret values are never changed.
 */
export async function instanceRepair(deps: ActionDeps, instanceId: string): Promise<RepairOutcome> {
  const store = new ManifestStore(instanceId, deps.root);
  const paths = instancePaths(instanceId, deps.root);
  const invStore = new InventoryStore(deps.root);
  const notes: string[] = [];
  const now = deps.now?.() ?? new Date().toISOString();

  const dirExists = await stat(paths.dir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  const inventory = await invStore.read().catch(() => null);
  const entry = inventory?.instances.find((i) => i.instanceId === instanceId) ?? null;
  if (!dirExists && !entry) {
    throw new Error(
      `Instance "${instanceId}" has no directory under ${instancesDir(deps.root)} and no inventory entry — nothing to repair. ` +
        'To recover a fully deleted instance, restore it from a backup copy or reinstall it.',
    );
  }

  // Backfill the per-instance manager token for pre-token installs (mirrors
  // the instanceUpdate backfill). Additive only — an existing token is never
  // changed; the backend picks it up when its container is next recreated.
  let mintedToken = false;
  const onDiskSecrets = await readInstanceSecrets(paths.secretsDir);
  if (onDiskSecrets !== null) {
    const ensured = ensureManagerToken(onDiskSecrets);
    if (ensured.minted) {
      await writeInstanceSecrets(paths.secretsDir, ensured.secrets, deps.secretIO);
      mintedToken = true;
      notes.push(
        'Minted the missing per-instance manager token (SELFHELP_MANAGER_TOKEN); recreate the backend container to enable the CMS-requested update loop.',
      );
    }
  }

  // 1. Intact manifest: the only possible repair is a missing inventory entry.
  const intact = await store.read().catch(() => null);
  if (intact) {
    if (!entry && inventory) {
      await invStore.upsertInstance(
        {
          instanceId,
          domain: intact.domain,
          path: paths.dir,
          composeProject: composeProjectName(instanceId),
          status: 'active',
        },
        inventory,
      );
      notes.push('Manifest is valid; re-registered the instance in the server inventory.');
      return { repaired: true, source: 'intact', manifestPath: store.path, notes };
    }
    if (!mintedToken) notes.push('Manifest and inventory are consistent; nothing to repair.');
    return { repaired: mintedToken, source: 'intact', manifestPath: store.path, notes };
  }

  // 2. Newest backup snapshot wins: it is a validated, full-fidelity copy.
  const snapshot = await newestBackupManifestSnapshot(paths.backupsDir, instanceId);
  let manifest: InstanceManifest;
  let source: 'backup' | 'reconstructed';
  if (snapshot) {
    manifest = { ...snapshot.manifest, updatedAt: now };
    source = 'backup';
    notes.push(
      `Restored the manifest from backup ${snapshot.backupId} (instance state as of ${snapshot.manifest.updatedAt}); ` +
        'review it if the instance changed since that backup.',
    );
  } else {
    manifest = await reconstructManifestFromState(deps, instanceId, entry?.domain ?? null, now);
    source = 'reconstructed';
    notes.push(
      'Reconstructed the manifest from the inventory + lock + compose file. Display name, creation time and ' +
        'registry channel are best-effort defaults — review them.',
    );
  }

  await store.write(manifest);
  notes.push(`Wrote ${store.path}.`);

  // 3. Make sure the inventory knows the instance again.
  if (inventory && !entry) {
    await invStore.upsertInstance(
      {
        instanceId,
        domain: manifest.domain,
        path: paths.dir,
        composeProject: composeProjectName(instanceId),
        status: 'active',
      },
      inventory,
    );
    notes.push('Re-registered the instance in the server inventory.');
  }
  return { repaired: true, source, manifestPath: store.path, notes };
}

/** Newest backup directory containing a valid manifest snapshot for this instance. */
async function newestBackupManifestSnapshot(
  backupsDir: string,
  instanceId: string,
): Promise<{ backupId: string; createdAt: string; manifest: InstanceManifest } | null> {
  const names = await readdir(backupsDir, { withFileTypes: true })
    .then((entries) => entries.filter((d) => d.isDirectory()).map((d) => d.name))
    .catch(() => [] as string[]);
  const candidates: { backupId: string; createdAt: string; manifest: InstanceManifest }[] = [];
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(backupsDir, name, 'selfhelp.instance.json'), 'utf8'));
      const v = validateInstanceManifest(raw);
      if (!v.valid || !v.value || v.value.instanceId !== instanceId) continue;
      const backupMeta = JSON.parse(
        await readFile(path.join(backupsDir, name, 'backup-manifest.json'), 'utf8'),
      ) as BackupManifest;
      candidates.push({ backupId: name, createdAt: backupMeta.createdAt ?? v.value.updatedAt, manifest: v.value });
    } catch {
      // Unreadable backup folder: skip it as a repair source.
    }
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return candidates[0] ?? null;
}

/**
 * Rebuilds a manifest with no backup snapshot available: versions/plugins from
 * the lock file, images + mode + local port from the generated compose file,
 * domain from the inventory entry. Throws with recovery guidance when even
 * these sources are gone.
 */
async function reconstructManifestFromState(
  deps: ActionDeps,
  instanceId: string,
  inventoryDomain: string | null,
  now: string,
): Promise<InstanceManifest> {
  const paths = instancePaths(instanceId, deps.root);
  const lock = await new LockStore(instanceId, deps.root).read().catch(() => null);
  const composeText = await readFile(paths.composePath, 'utf8').catch(() => null);
  if (!lock || composeText === null) {
    throw new Error(
      `Cannot repair "${instanceId}": no backup manifest snapshot and ${lock ? 'no compose file' : 'no lock file'} ` +
        `under ${paths.dir}. Restore the instance from a backup or reinstall it.`,
    );
  }

  const compose = parseYaml(composeText) as {
    services?: Record<string, { image?: string; ports?: unknown[] }>;
  };
  const services = compose.services ?? {};
  const image = (name: string): string => {
    const img = services[name]?.image;
    if (!img) throw new Error(`Cannot repair "${instanceId}": the compose file declares no image for service "${name}".`);
    return img;
  };
  const images = {
    backend: image('backend'),
    frontend: image('frontend'),
    scheduler: image('scheduler'),
    worker: image('worker'),
    mysql: image('mysql'),
    redis: image('redis'),
    mercure: image('mercure'),
  };

  // The generated compose publishes a localhost port ONLY in local mode
  // (production routes through the shared proxy network instead).
  const portEntry = (services.frontend?.ports ?? []).find((p): p is string => typeof p === 'string') ?? null;
  const mode: InstanceMode = portEntry ? 'local' : 'production';
  const localPort = portEntry ? Number(portEntry.split(':')[1]) : undefined;
  const domain = inventoryDomain || (mode === 'local' && localPort !== undefined ? `localhost:${localPort}` : '');
  if (domain === '') {
    throw new Error(
      `Cannot repair "${instanceId}": the server inventory has no domain for this production instance. ` +
        'Restore from a backup, or re-register the instance first.',
    );
  }
  const publicFrontendUrl = mode === 'production' ? `https://${domain}` : `http://localhost:${localPort}`;
  const frontendVersion = images.frontend.includes(':')
    ? images.frontend.slice(images.frontend.lastIndexOf(':') + 1)
    : lock.core.version;

  return {
    manifestVersion: 1,
    instanceId,
    displayName: instanceId,
    domain,
    mode,
    createdAt: now,
    updatedAt: now,
    registry: { id: lock.registry.id, url: lock.registry.url, channel: 'stable' },
    versions: {
      selfhelp: lock.core.version,
      backend: lock.core.version,
      frontend: frontendVersion,
      scheduler: lock.core.version,
      worker: lock.core.version,
      pluginApi: lock.core.pluginApiVersion,
    },
    images,
    routing: buildInstanceRouting({
      instanceId,
      mode,
      selfhelpVersion: lock.core.version,
      frontendVersion,
      publicFrontendUrl,
    }),
    installedPlugins: Object.entries(lock.plugins).map(([id, p]) => ({ id, version: p.version })),
  };
}

// ---------------------------------------------------------------------------
// instance safe-mode (delegates to the canonical backend console command)
// ---------------------------------------------------------------------------

// System safe mode boots the backend with core bundles only (no plugins).
// `selfhelp:safe-mode` is the canonical command; it is a thin alias over the
// plugin safe-mode mechanism (var/plugin_safe_mode.lock), so the legacy
// `selfhelp:plugin:safe-mode` keeps working too.
export async function instanceSafeMode(deps: ActionDeps, instanceId: string, enable: boolean): Promise<void> {
  const paths = instancePaths(instanceId, deps.root);
  await deps.runner.run(paths.dir, [
    'exec',
    '-T',
    'backend',
    'php',
    'bin/console',
    'selfhelp:safe-mode',
    enable ? '--enable' : '--disable',
  ]);
}
