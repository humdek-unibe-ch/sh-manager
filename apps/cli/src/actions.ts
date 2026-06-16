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
import { formatTrustedKeysEnv, validateInstanceManifest } from '@shm/schemas';
import type {
  BackupManifest,
  BackupOrigin,
  BackupSchedulePolicy,
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
import {
  DEFAULT_PROXY_NETWORK,
  MANAGER_CONTROLLED_ENV_KEYS,
  buildInstanceEnv,
  buildInstanceRouting,
  composeCommands,
  composeProjectName,
  generateInstanceComposeYaml,
  parseDotEnv,
  toEnginePath,
} from '@shm/docker';
import type { Fetcher } from '@shm/registry';
import { RegistryClient } from '@shm/registry';
import {
  assertSafeToBootstrap,
  assessBootstrapTarget,
  buildInstanceInstallArtifacts,
  buildServerBootstrap,
  evaluateHealth,
  evaluateMysqlMajorUpgrade,
  executeFrontendUpdate,
  executeUpdate,
  finalizePluginOperations,
  installInstance,
  planFrontendUpdate,
  planUpdate,
  reinstallPluginsForCore,
  resolveTargetRuntimeImages,
  restorePluginStateIfNeeded,
  processNextOperation,
  drainOperations,
  provisionInstance,
  runPreflight,
  type ApprovedUpdate,
  type BackendOperationsClient,
  type BootstrapTargetFacts,
  type FrontendUpdatePlan,
  type HealthReport,
  type OperationExecutor,
  type OperationLifecycleStatus,
  type PendingOperation,
  type PendingPluginOperation,
  type PhaseReporter,
  type PluginDrainReport,
  type PluginExecDeps,
  type PreflightResourceFacts,
  type ProcessOutcome,
  type ProvisionReport,
  type ProvisionStepName,
  type ServiceProbeResult,
  type UpdateExecutionReport,
  type UpdatePlan,
  type UpdateStepResult,
} from '@shm/core';
import {
  InventoryStore,
  LockStore,
  ManifestStore,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
  ensureManagerToken,
  generateCloneSecrets,
  generateInstanceReadme,
  instancePaths,
  instancesDir,
  nodeSecretIO,
  planEnable,
  planRemove,
  proxyDir,
  readInstanceSecrets,
  redactMailerDsn,
  secretsForRestore,
  serverInventoryPath,
  validateDomainForInstall,
  withMailerDsn,
  writeFileAtomic,
  writeInstanceSecrets,
  type EnablePlan,
  type GenerateSecretsOptions,
  type InstancePaths,
  type RemoveMode,
  type RemovePlan,
  type SecretIO,
} from '@shm/instances';
import {
  DEFAULT_BACKUP_RETENTION,
  REQUIRED_BACKUP_AREAS,
  buildBackupManifest,
  estimateFootprint,
  isBackupDue,
  makeBackupId,
  nextBackupSeq,
  nextRunAt,
  planClone,
  planPrune,
  planRestore,
  validateBackupForRestore,
  validateSchedulePolicy,
  type BackupCandidate,
  type BackupValidation,
  type ClonePlan,
  type CloneRequest,
  type FootprintEstimate,
  type PrunePlan,
  type RestoreMode,
  type RestorePlan,
  type RestoreRequest,
} from '@shm/backup';
import { assembleSupportBundle, redactEnv, redactString } from '@shm/support';
import { ComposeExecPluginStateClient, composePluginExecDeps, type PluginStateClient } from './plugin-state-client.js';

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
  /** Remove a Docker network; tolerate "not found" (server purge only). */
  removeNetwork?: (name: string) => Promise<void>;
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

/**
 * Import a SQL dump with a bounded retry. `waitForMysqlReady` can pass against
 * MySQL's first-boot TEMPORARY server, which then restarts before the real one
 * comes up — the import's client connection dies with ERROR 2002 mid-stream.
 * The dump is idempotent (mysqldump emits CREATE DATABASE + DROP TABLE IF
 * EXISTS per table), so re-confirming readiness and re-running it is safe.
 */
async function importDatabaseWithRetry(deps: ActionDeps, instanceDir: string, sqlFile: string): Promise<void> {
  if (!deps.importDatabase) throw new Error('importDatabase host helper missing.');
  const attempts = 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await waitForMysqlReady(deps, instanceDir);
    try {
      await deps.importDatabase(instanceDir, sqlFile);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Database import failed after ${attempts} attempts: ${errMessage(lastErr)}`);
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
  const names = await readdir(instancesDir(root), { withFileTypes: true })
    .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
    .catch(() => [] as string[]);
  // Folders holding ONLY retained backups (what full_delete / server purge
  // leave behind on purpose) are not instances and must not block a fresh
  // bootstrap — same rule instanceList applies before reporting `broken`.
  const real: string[] = [];
  for (const name of names) {
    if (await looksLikeInstanceState(instancePaths(name, root))) real.push(name);
  }
  return real;
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

/**
 * Idempotently (re)start the shared Traefik proxy. PRODUCTION only — local mode
 * routes via published ports and must never grab 80/443 on a dev host.
 *
 * The proxy is the single entry point in production (it terminates TLS and routes
 * every instance), but it was only ever started by the FIRST `server init`. If
 * that first bring-up failed — the pre-1.5.1 proxy-network label bug, or another
 * web server (Apache/nginx) holding 80/443 at the time — the inventory was still
 * written, so every later install/reinstall skipped `server init` and the proxy
 * stayed down: instances install fine but are unreachable and health is
 * `unhealthy` with no command to bring just the proxy back. Calling this on every
 * production bring-up (install, set-address, enable) self-heals that state, and
 * `sh-manager server start` exposes it as an explicit repair. A no-op when the
 * proxy compose has not been written yet (server not bootstrapped).
 */
export async function ensureProxyRunning(deps: ActionDeps, mode: InstanceMode): Promise<void> {
  if (mode !== 'production') return;
  const dir = proxyDir(deps.root);
  const composePath = `${dir}/compose.yaml`;
  if (!(await pathExists(composePath))) return;

  const inventory = await new InventoryStore(deps.root).read().catch(() => null);
  const network = inventory?.proxy.network ?? DEFAULT_PROXY_NETWORK;

  // Regenerate the proxy compose from the current template before bringing it
  // up. A proxy compose written by a manager < 1.5.1 declared the shared network
  // as NON-external, so `docker compose up` tries to own the manager-created
  // network and aborts with a label mismatch — exactly the state a server is
  // stuck in after that failed first bootstrap. Re-emitting it (external network)
  // self-heals that on disk. The Let's Encrypt email is recovered from the
  // existing compose (it is required for the production template and is not
  // stored elsewhere); without it we leave the file as-is and still attempt the
  // bring-up so a current compose is unaffected.
  const existing = await readFile(composePath, 'utf8').catch(() => '');
  const letsencryptEmail = existing.match(/acme\.email=([^\s'"]+)/)?.[1];
  if (letsencryptEmail) {
    const boot = buildServerBootstrap({
      serverId: inventory?.serverId ?? 'selfhelp',
      managerVersion: deps.managerVersion,
      mode: 'production',
      root: deps.root,
      ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
      letsencryptEmail,
      proxyNetwork: network,
    });
    await writeFileAtomic(boot.proxyComposePath, boot.proxyComposeYaml);
  }

  await deps.ensureNetwork?.(network);
  await deps.runner.run(dir, composeCommands.upDetached());
}

/**
 * Explicit operator repair: ensure the shared production proxy is running. Reads
 * the server's mode from any installed instance manifest (the inventory does not
 * record server mode); defaults to production when at least one instance is
 * production, so a server bootstrapped with a domain always re-starts its proxy.
 */
export async function serverStartProxy(deps: ActionDeps): Promise<{ started: boolean; network: string }> {
  const inventory = await new InventoryStore(deps.root).read();
  let production = false;
  for (const entry of inventory.instances) {
    const manifest = await new ManifestStore(entry.instanceId, deps.root).read().catch(() => null);
    if (manifest?.mode === 'production') {
      production = true;
      break;
    }
  }
  await ensureProxyRunning(deps, production ? 'production' : 'local');
  return { started: production, network: inventory.proxy.network };
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
   * Operator SMTP DSN (e.g. `smtp://user:pass@mail.example.org:587`). Stored
   * in the instance's secrets.env (0600); overrides the local Mailpit default.
   */
  mailerDsn?: string;
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
    pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
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
  // Guarantee the shared proxy is up in production: an instance only becomes
  // reachable (and gets its TLS cert) through it, and a server whose first
  // `server init` failed to start the proxy would otherwise install the
  // instance but leave it unreachable on every retry.
  if (bringUp) await ensureProxyRunning(deps, opts.mode);
  const res = await installInstance(artifacts, {
    root: deps.root,
    runner: deps.runner,
    bringUp,
    ...(opts.mailerDsn !== undefined ? { mailerDsn: opts.mailerDsn } : {}),
  });

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
 * Carries the SOURCE instance's generated admin bootstrap password into a fresh
 * clone. A clone copies the source DATABASE (so the admin user row AND its
 * password hash come along), but it deliberately generates its own fresh
 * `secrets.env` as a separate security boundary — which means it has NO
 * `admin_password` file of its own. Without this, `instance admin-password
 * <clone>` returns nothing even though the cloned admin login is valid (it is the
 * source's). Copying the 0600 plaintext file keeps the "retrieve the admin
 * password from the server" flow working for the clone too.
 *
 * No-op when the source never persisted one (the operator supplied their own
 * password at install, so they already hold it) — returns `undefined`.
 */
async function copyAdminPasswordToClone(
  deps: ActionDeps,
  sourceInstanceId: string,
  targetInstanceId: string,
): Promise<string | undefined> {
  const sourceFile = path.join(instancePaths(sourceInstanceId, deps.root).secretsDir, ADMIN_PASSWORD_FILENAME);
  const password = (await readFile(sourceFile, 'utf8').catch(() => '')).trim();
  if (password === '') return undefined;
  const targetPaths = instancePaths(targetInstanceId, deps.root);
  const targetFile = path.join(targetPaths.secretsDir, ADMIN_PASSWORD_FILENAME);
  const io = deps.secretIO ?? nodeSecretIO;
  await io.ensureDir(targetPaths.secretsDir, SECRET_DIR_MODE);
  await io.writeFile(targetFile, `${password}\n`, SECRET_FILE_MODE);
  return targetFile;
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
  /**
   * Live progress hook: invoked the instant each execution step is recorded so
   * the manager journal can advance its phase + stream the log in real time
   * (best-effort — a throwing hook never breaks the update).
   */
  onStep?: (step: UpdateStepResult) => void | Promise<void>;
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
        const backup = await instanceBackup(deps, instanceId, { mode: 'maintenance', origin: 'pre_update' });
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
          pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
          // Operator env overrides survive an update (they are re-merged into
          // the freshly generated .env, structural keys excepted).
          ...(manifest.envOverrides ? { envOverrides: manifest.envOverrides } : {}),
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
      // The update recreated every container from fresh images, which resets
      // vendor/ to the baked state while the database still records the
      // installed plugins. Re-require each one against the NEW core, repair
      // the plugin layer, and propagate the state to worker + scheduler.
      restorePlugins: async () => {
        const { client, execDeps } = pluginSeams(deps, instanceId);
        const plugins = await client.listInstalledPlugins();
        if (plugins.length === 0) return;
        await reinstallPluginsForCore({ plugins, coreVersion: plan.targetVersion! }, execDeps);
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
      ...(opts.onStep ? { onStep: opts.onStep } : {}),
    },
  );

  return { plan, executed: true, report };
}

// ---------------------------------------------------------------------------
// instance frontend update (frontend-only, dry-run + execute)
// ---------------------------------------------------------------------------

export interface InstanceFrontendUpdateOptions {
  dryRun?: boolean;
  channel?: ReleaseChannel;
  /** 'latest' (default) or a specific frontend version. */
  target?: string;
  /** Live progress hook (see {@link InstanceUpdateOptions.onStep}). */
  onStep?: (step: UpdateStepResult) => void | Promise<void>;
}

/**
 * Update ONLY the frontend of an instance to a newer compatible release,
 * leaving the core stack (backend/worker/scheduler) and every volume untouched.
 *
 * The frontend ships independently of the core, so an instance already on the
 * latest core can still have a newer frontend available — the core-driven
 * {@link instanceUpdate} reports `up_to_date` and never picks it up. This is the
 * lightweight path: it resolves the newest compatible frontend, rewrites the
 * instance artifacts with the new image, pulls it, recreates ONLY the frontend
 * container, health-checks, and restores the previous config + container on
 * failure. No backup, no migration, no maintenance window are needed because
 * the frontend is stateless.
 */
export async function instanceFrontendUpdate(
  deps: ActionDeps,
  instanceId: string,
  opts: InstanceFrontendUpdateOptions,
): Promise<{ plan: FrontendUpdatePlan; executed: boolean; report?: Awaited<ReturnType<typeof executeFrontendUpdate>> }> {
  const manifestStore = new ManifestStore(instanceId, deps.root);
  const lockStore = new LockStore(instanceId, deps.root);
  const manifest = await readManifestFriendly(deps, instanceId);
  const lock = await lockStore.read();
  const channel = opts.channel ?? manifest.registry.channel;
  const client = registryClient(deps, manifest.registry.url);
  const index = await client.getIndex();

  const frontendReleases = await fetchAllFrontends(client, index.frontend, channel);

  // Best-effort: fetch the running core release so its required frontend range
  // is enforced too (a frontend-only update must never move to a frontend the
  // running core forbids). If the core is no longer published, fall back to the
  // candidate frontend's own required-core-range check.
  let currentCore: CoreRelease | null = null;
  const coreRef = index.core.find(
    (r) =>
      r.channel === channel &&
      !r.blocked &&
      semver.eq(semver.coerce(r.version) ?? '0.0.0', semver.coerce(manifest.versions.selfhelp) ?? '0.0.0'),
  );
  if (coreRef) {
    currentCore = (await client.getCoreRelease(coreRef)).release;
  }

  const plan = planFrontendUpdate({
    instanceId,
    currentFrontendVersion: manifest.versions.frontend,
    coreVersion: manifest.versions.selfhelp,
    currentCore,
    frontendReleases,
    channel,
    ...(opts.target ? { target: opts.target } : {}),
  });

  if (opts.dryRun || plan.status !== 'ok' || plan.frontend === null) {
    return { plan, executed: false };
  }

  const paths = instancePaths(instanceId, deps.root);
  // The core stays EXACTLY as installed (pinned from the lock); only the
  // frontend release moves to the resolved target.
  const { core } = releaseShapesFromLock(manifest, lock, 'frontend-update');
  const frontend = plan.frontend;

  let preUpdateSnapshot:
    | { compose: string; env: string; readme: string; manifest: InstanceManifest; lock: InstanceLock }
    | null = null;

  const report = await executeFrontendUpdate(plan, {
    runner: deps.runner,
    instanceDir: paths.dir,
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
        ...(manifest.mode === 'production'
          ? { domain: manifest.domain }
          : { localPort: Number(new URL(manifest.routing.publicFrontendUrl).port) }),
        root: deps.root,
        ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
        managerVersion: deps.managerVersion,
        channel,
        registry: {
          id: manifest.registry.id,
          url: manifest.registry.url,
          metadataSha256: client.lastSuccessfulCheck?.metadataSha256 ?? lock.registry.metadataSha256,
        },
        // Same core (pinned from lock), new frontend, same runtime services.
        core,
        frontend,
        services: lock.services,
        installedPlugins: manifest.installedPlugins,
        pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
        ...(manifest.envOverrides ? { envOverrides: manifest.envOverrides } : {}),
      });
      await writeFileAtomic(paths.composePath, artifacts.composeYaml);
      await writeFileAtomic(paths.envPath, artifacts.envText);
      await writeFileAtomic(paths.readmePath, artifacts.readme);
      await manifestStore.write({
        ...artifacts.manifest,
        createdAt: manifest.createdAt,
        updatedAt: deps.now?.() ?? new Date().toISOString(),
      });
      await lockStore.write(artifacts.lock);
    },
    // The `up -d` recreate above drops composer-installed plugin vendor/ from the
    // Symfony containers' writable layer; restore it from the snapshot so the
    // CMS keeps its plugins (no-op when none are installed). The core version is
    // unchanged by a frontend update, so the snapshot key stays the same.
    restorePluginState: async () => {
      await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
    },
    checkHealth: async () =>
      evaluateHealth(
        instanceId,
        await deps.probeHealth(manifest.routing.publicFrontendUrl, manifest.routing.browserApiPrefix),
        deps.now,
      ),
    rollback: async () => {
      if (preUpdateSnapshot) {
        const snap = preUpdateSnapshot;
        if (snap.compose) await writeFileAtomic(paths.composePath, snap.compose);
        if (snap.env) await writeFileAtomic(paths.envPath, snap.env);
        if (snap.readme) await writeFileAtomic(paths.readmePath, snap.readme);
        await manifestStore.write(snap.manifest);
        await lockStore.write(snap.lock);
      }
      // Recreate from the restored (previous) compose + .env so the backend
      // reverts to the previous frontend version stamp too, then re-mount plugins.
      await deps.runner.run(paths.dir, composeCommands.upDetached());
      await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
    },
    ...(opts.onStep ? { onStep: opts.onStep } : {}),
  });

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
    if (op.kind === 'frontend') {
      return executeFrontendOperation(deps, approved, op, phase);
    }

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
 * Runs a CMS-requested FRONTEND-only operation. It reuses
 * {@link instanceFrontendUpdate} and maps its lightweight report onto the
 * shared {@link UpdateExecutionReport} shape (target = the frontend version)
 * so the operations loop writes it back like any other update.
 */
async function executeFrontendOperation(
  deps: ActionDeps,
  approved: ApprovedUpdate,
  op: PendingOperation,
  phase: PhaseReporter,
): Promise<UpdateExecutionReport> {
  const targetFrontend = op.targetFrontendVersion ?? op.targetVersion;
  await phase('preflight_running', 10, `Resolving frontend update to ${targetFrontend}.`);

  const res = await instanceFrontendUpdate(deps, approved.instanceId, { target: targetFrontend });

  if (!res.executed || !res.report) {
    return {
      instanceId: approved.instanceId,
      targetVersion: targetFrontend,
      ok: false,
      rolledBack: false,
      steps: [{ name: 'plan', status: 'failed', detail: `plan status: ${res.plan.status}` }],
    };
  }

  await phase('update_running', 60);
  await phase('health_check_running', 90);
  return {
    instanceId: res.report.instanceId,
    targetVersion: res.report.targetFrontendVersion,
    ok: res.report.ok,
    rolledBack: res.report.rolledBack,
    steps: res.report.steps,
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
  onPhase?: (
    op: PendingOperation,
    status: OperationLifecycleStatus,
    progressPercent: number,
    detail?: string,
  ) => void | Promise<void>,
): Promise<ProcessOutcome[]> {
  const manifest = await readManifestFriendly(deps, instanceId);
  return drainOperations({
    trustedInstanceId: manifest.instanceId,
    client,
    execute: buildOperationExecutor(deps),
    ...(deps.now ? { now: deps.now } : {}),
    ...(onPhase ? { onPhase } : {}),
  });
}

// ---------------------------------------------------------------------------
// CMS plugin operations (managed install mode: the manager is the operator)
// ---------------------------------------------------------------------------

export interface PluginDrainOverrides {
  /** Injectable transport (tests); default: compose-exec into the backend. */
  client?: PluginStateClient;
  /** Injectable exec seam (tests); default: compose exec/restart. */
  execDeps?: PluginExecDeps;
  log?: (line: string) => void | Promise<void>;
  /**
   * Called once with the parked operations the drain is about to run, BEFORE
   * any composer step. Lets the BFF label the journaled operation with what it
   * is actually doing ("Installing plugin X 0.2.1") instead of the generic
   * "cms operations drain" — addresses operators not knowing a drain was a
   * plugin install. Reporting failures must never abort the drain.
   */
  onPlanned?: (ops: PendingPluginOperation[]) => void | Promise<void>;
}

/** One-line human summary of a parked plugin operation, for phases/logs. */
export function describePluginOperation(op: PendingPluginOperation): string {
  const verb =
    op.type === 'install'
      ? 'Installing'
      : op.type === 'update'
        ? 'Updating'
        : op.type === 'purge'
          ? 'Purging'
          : 'Uninstalling';
  const version = op.version ? ` ${op.version}` : '';
  return `${verb} plugin ${op.pluginId}${version}`;
}

function pluginSeams(
  deps: ActionDeps,
  instanceId: string,
  overrides?: PluginDrainOverrides,
): { client: PluginStateClient; execDeps: PluginExecDeps } {
  const instanceDir = instancePaths(instanceId, deps.root).dir;
  return {
    client: overrides?.client ?? new ComposeExecPluginStateClient({ runner: deps.runner, instanceDir }),
    execDeps: overrides?.execDeps ?? composePluginExecDeps(deps.runner, instanceDir, overrides?.log),
  };
}

/** Cheap peek used by pollers: is any managed plugin operation parked for us? */
export async function hasPendingPluginOperations(
  deps: ActionDeps,
  instanceId: string,
  overrides?: PluginDrainOverrides,
): Promise<boolean> {
  const { client } = pluginSeams(deps, instanceId, overrides);
  return (await client.listPendingOperations()).length > 0;
}

/**
 * Drains parked managed-mode plugin operations (install/update/uninstall):
 * runs the runbook's composer step in the backend, finalizes via
 * `selfhelp:plugin:run-operation`, enables new installs, then snapshots the
 * composer state to the shared plugin volume, syncs worker + scheduler from
 * it, and restarts the Symfony services so the new bundles load everywhere.
 */
export async function drainInstancePluginOperations(
  deps: ActionDeps,
  instanceId: string,
  overrides?: PluginDrainOverrides,
): Promise<PluginDrainReport> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const { client, execDeps } = pluginSeams(deps, instanceId, overrides);
  const operations = await client.listPendingOperations();
  if (operations.length === 0) return { outcomes: [], restarted: false };
  // Surface WHAT is about to run before we start (label the journaled op).
  if (overrides?.onPlanned) {
    try {
      await overrides.onPlanned(operations);
    } catch {
      // Labeling is best-effort; never let it block the actual drain.
    }
  }
  return finalizePluginOperations({ operations, coreVersion: manifest.versions.selfhelp }, execDeps);
}

/** Operator-facing view of one plugin actually installed in a running instance. */
export interface InstalledPluginInfo {
  id: string;
  version: string;
  enabled: boolean;
}

/**
 * Read the plugins ACTUALLY installed in a running instance, straight from its
 * `plugins` table (the durable source of truth), rather than the possibly-stale
 * `installedPlugins` recorded in the manifest. Requires the instance to be up
 * (it execs a read-only query inside the backend container). Throws when the
 * instance is down / has no plugin support; the manager treats that as "unknown"
 * and falls back to the manifest.
 */
export async function instanceListInstalledPlugins(
  deps: ActionDeps,
  instanceId: string,
  overrides?: PluginDrainOverrides,
): Promise<InstalledPluginInfo[]> {
  const { client } = pluginSeams(deps, instanceId, overrides);
  const rows = await client.listInstalledPlugins();
  return rows
    .map((r) => ({ id: r.pluginId, version: r.version, enabled: r.enabled }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Best-effort plugin-state restore after containers were recreated WITHOUT a
 * version change (address/mailer change, manual recreate): if the marker file
 * is gone but a composer-state snapshot exists on the plugin volume, extract
 * it into backend/worker/scheduler and restart them. Never throws — the
 * primary action (address/mailer/start) must not fail because of this.
 */
async function restorePluginStateAfterRecreate(
  deps: ActionDeps,
  instanceId: string,
  coreVersion: string,
): Promise<boolean> {
  try {
    const { execDeps } = pluginSeams(deps, instanceId);
    const res = await restorePluginStateIfNeeded(execDeps, coreVersion);
    return res.restored;
  } catch {
    return false;
  }
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

/**
 * Live progress event for long operations (backup/restore). `phase` is the
 * machine id the UI step-checklist matches on (see `operation-steps.ts`);
 * `detail` is the human log line. Reporting is best-effort and must never
 * change the operation's outcome.
 */
export interface OperationProgress {
  phase: string;
  detail: string;
}

export interface BackupOptions {
  mode?: 'maintenance' | 'online';
  origin?: BackupOrigin;
  seq?: number;
  /** Fires as each backup stage starts so the BFF can advance the live UI. */
  onStep?: (step: OperationProgress) => void | Promise<void>;
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
  // Same-day backups must never share an id (the directory would silently be
  // overwritten): pick the next free sequence from what is already on disk.
  const existing = await readdir(paths.backupsDir).catch(() => [] as string[]);
  const seq = opts.seq ?? nextBackupSeq(existing, instanceId, new Date(createdAt));
  const backupId = makeBackupId(instanceId, new Date(createdAt), seq);
  const backupDir = path.join(paths.backupsDir, backupId);
  await mkdir(backupDir, { recursive: true });

  const includedAreas = ['database', 'manifest', 'lock'];
  const step = async (phase: string, detail: string): Promise<void> => {
    try {
      await opts.onStep?.({ phase, detail });
    } catch {
      // Progress reporting is best-effort; never let it abort a backup.
    }
  };

  // 1. Database dump (maintenance-mode default; mysqldump runs in the db container).
  await step('database', 'Dumping database…');
  const { stdout: dump } = await deps.runner.run(paths.dir, ['exec', '-T', 'mysql', 'sh', '-lc', APP_DB_DUMP_CMD]);
  await writeFile(path.join(backupDir, 'database.sql'), dump);

  // 2. Metadata snapshots (manifest + lock + redacted env + compose copy).
  await step('metadata', 'Snapshotting manifest, lock, env & compose…');
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
    await step('volumes', 'Archiving uploads & plugin artifacts…');
    await deps.archiveVolume(`${project}_uploads`, path.join(backupDir, 'uploads.tgz'));
    includedAreas.push('uploads');
    await deps.archiveVolume(`${project}_plugin_artifacts`, path.join(backupDir, 'plugin_artifacts.tgz'));
    await deps.archiveVolume(
      `${project}_plugin_artifacts_public`,
      path.join(backupDir, 'plugin_artifacts_public.tgz'),
    );
    includedAreas.push('plugin_artifacts');
  }

  await step('manifest', 'Writing backup manifest & checksums…');
  const files = await hashFilesIn(backupDir, ['backup-manifest.json']);
  const backupManifest = buildBackupManifest({
    instanceId,
    selfhelpVersion: manifest.versions.selfhelp,
    migrationVersion: lock.core.migrationVersion,
    plugins: manifest.installedPlugins,
    mode: opts.mode,
    origin: opts.origin,
    includedAreas,
    files,
    createdAt,
    seq,
  });
  await writeFile(path.join(backupDir, 'backup-manifest.json'), JSON.stringify(backupManifest, null, 2));

  return { backupId, backupDir, manifest: backupManifest };
}

// ---------------------------------------------------------------------------
// scheduled backups + GFS retention
// ---------------------------------------------------------------------------

/** Free disk required for a scheduled backup when there is no size history yet. */
const MIN_FREE_BYTES_FOR_SCHEDULED_BACKUP = 512 * 1024 * 1024;

/** One on-disk backup, as read back from its `backup-manifest.json`. */
export interface BackupDirEntry {
  /** Directory name == manifest backupId (mismatches are reported, never touched). */
  backupId: string;
  createdAt: string;
  origin: BackupOrigin;
  totalBytes: number;
}

export interface BackupDirListing {
  entries: BackupDirEntry[];
  /** Directories under backups/ that are NOT safe prune candidates. */
  skipped: { name: string; reason: string }[];
}

/**
 * Reads every backup directory of an instance. Only directories whose name
 * matches the manifest's own backupId become candidates — anything else
 * (foreign folders, renamed/corrupt backups) is reported and left alone.
 */
export async function listInstanceBackups(deps: ActionDeps, instanceId: string): Promise<BackupDirListing> {
  const paths = instancePaths(instanceId, deps.root);
  const entries: BackupDirEntry[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(paths.backupsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { entries: [], skipped: [] };
  }
  for (const name of names) {
    try {
      const raw = await readFile(path.join(paths.backupsDir, name, 'backup-manifest.json'), 'utf8');
      const manifest = JSON.parse(raw) as BackupManifest;
      if (manifest.backupId !== name) {
        skipped.push({ name, reason: `manifest backupId "${manifest.backupId}" does not match the directory name` });
        continue;
      }
      if (manifest.instanceId !== instanceId) {
        skipped.push({ name, reason: `backup belongs to instance "${manifest.instanceId}"` });
        continue;
      }
      entries.push({
        backupId: name,
        createdAt: manifest.createdAt,
        origin: manifest.origin ?? 'manual',
        totalBytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
      });
    } catch {
      skipped.push({ name, reason: 'missing or unreadable backup-manifest.json' });
    }
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { entries, skipped };
}

// --- scheduler state (<root>/manager/backup-scheduler.json) ----------------

export type ScheduledRunResult = 'succeeded' | 'failed' | 'skipped_low_disk';

interface SchedulerInstanceState {
  /** Last occurrence that was covered (successfully or not) — drives isBackupDue. */
  lastRunAt: string;
  lastResult: ScheduledRunResult;
  lastBackupId?: string;
  lastDetail?: string;
}

interface BackupSchedulerState {
  version: 1;
  instances: Record<string, SchedulerInstanceState>;
}

function schedulerStatePath(root: string): string {
  return path.join(root, 'manager', 'backup-scheduler.json');
}

async function readSchedulerState(root: string): Promise<BackupSchedulerState> {
  try {
    const raw = await readFile(schedulerStatePath(root), 'utf8');
    const parsed = JSON.parse(raw) as BackupSchedulerState;
    if (parsed && parsed.version === 1 && parsed.instances) return parsed;
  } catch {
    // First run / unreadable state: start fresh (worst case one extra backup).
  }
  return { version: 1, instances: {} };
}

async function writeSchedulerState(root: string, state: BackupSchedulerState): Promise<void> {
  await mkdir(path.dirname(schedulerStatePath(root)), { recursive: true });
  await writeFileAtomic(schedulerStatePath(root), JSON.stringify(state, null, 2));
}

// --- schedule get/set -------------------------------------------------------

export interface BackupScheduleStatus {
  instanceId: string;
  /** Policy from the instance manifest; null when never configured. */
  policy: BackupSchedulePolicy | null;
  lastRunAt: string | null;
  lastResult: ScheduledRunResult | null;
  lastBackupId: string | null;
  lastDetail: string | null;
  /** Next scheduled run (ISO); null when disabled/unconfigured. */
  nextRunAt: string | null;
  backups: { count: number; totalBytes: number };
  footprint: FootprintEstimate;
}

export async function instanceBackupScheduleGet(
  deps: ActionDeps,
  instanceId: string,
  now: Date = new Date(),
): Promise<BackupScheduleStatus> {
  const manifest = await new ManifestStore(instanceId, deps.root).read();
  const policy = manifest.backupSchedule ?? null;
  const state = (await readSchedulerState(deps.root)).instances[instanceId] ?? null;
  const lastRunAt = state ? new Date(state.lastRunAt) : null;
  const { entries } = await listInstanceBackups(deps, instanceId);
  const retention = policy?.retention ?? DEFAULT_BACKUP_RETENTION;
  const next = policy ? nextRunAt(policy, lastRunAt, now) : null;
  return {
    instanceId,
    policy,
    lastRunAt: state?.lastRunAt ?? null,
    lastResult: state?.lastResult ?? null,
    lastBackupId: state?.lastBackupId ?? null,
    lastDetail: state?.lastDetail ?? null,
    nextRunAt: next ? next.toISOString() : null,
    backups: { count: entries.length, totalBytes: entries.reduce((sum, e) => sum + e.totalBytes, 0) },
    footprint: estimateFootprint(retention, entries.map((e) => e.totalBytes)),
  };
}

/** Validates and persists the schedule policy on the instance manifest (atomic). */
export async function instanceBackupScheduleSet(
  deps: ActionDeps,
  instanceId: string,
  policy: BackupSchedulePolicy,
  now: Date = new Date(),
): Promise<BackupScheduleStatus> {
  const problems = validateSchedulePolicy(policy);
  if (problems.length > 0) {
    throw new Error(`Invalid backup schedule: ${problems.join(' ')}`);
  }
  const store = new ManifestStore(instanceId, deps.root);
  const manifest = await store.read();
  manifest.backupSchedule = policy;
  manifest.updatedAt = deps.now?.() ?? new Date().toISOString();
  await store.write(manifest);
  return instanceBackupScheduleGet(deps, instanceId, now);
}

// --- prune ------------------------------------------------------------------

export interface PruneExecutionReport {
  plan: PrunePlan;
  /** Backup ids actually deleted (empty on dry runs). */
  deleted: string[];
  /** Directories that were never considered (foreign/corrupt — left alone). */
  skipped: { name: string; reason: string }[];
  dryRun: boolean;
}

/**
 * Applies GFS retention to one instance's backups. Deletes ONLY directories
 * that (a) the retention plan lists, (b) match the strict backup-id pattern of
 * THIS instance, and (c) resolve to a direct child of the instance's backups
 * directory. Everything else is reported, never touched.
 */
export async function instanceBackupPrune(
  deps: ActionDeps,
  instanceId: string,
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<PruneExecutionReport> {
  const paths = instancePaths(instanceId, deps.root);
  const manifest = await new ManifestStore(instanceId, deps.root).read();
  const retention = manifest.backupSchedule?.retention ?? DEFAULT_BACKUP_RETENTION;
  const now = opts.now ?? (deps.now ? new Date(deps.now()) : new Date());

  const { entries, skipped } = await listInstanceBackups(deps, instanceId);
  const candidates: BackupCandidate[] = entries.map((e) => ({
    backupId: e.backupId,
    createdAt: e.createdAt,
    origin: e.origin,
  }));
  const plan = planPrune(candidates, retention, now);

  const deleted: string[] = [];
  if (!opts.dryRun) {
    // Defense in depth: the id pattern is instance-scoped, and the resolved
    // path must stay a direct child of backups/ — anything else is skipped.
    const idPattern = new RegExp(`^backup-\\d{8}-${instanceId}-\\d{3,}$`);
    const backupsRoot = path.resolve(paths.backupsDir);
    for (const decision of plan.prune) {
      if (!idPattern.test(decision.backupId)) {
        skipped.push({ name: decision.backupId, reason: 'prune refused: id does not match this instance\'s backup pattern' });
        continue;
      }
      const dir = path.resolve(backupsRoot, decision.backupId);
      if (path.dirname(dir) !== backupsRoot) {
        skipped.push({ name: decision.backupId, reason: 'prune refused: path escapes the backups directory' });
        continue;
      }
      await rm(dir, { recursive: true, force: true });
      deleted.push(decision.backupId);
    }
  }

  return { plan, deleted, skipped, dryRun: opts.dryRun ?? false };
}

// --- the scheduled run (one-shot; the web loop and cron both call this) ------

export interface ScheduledBackupRunEntry {
  instanceId: string;
  action: 'backup_taken' | 'skipped_not_due' | 'skipped_not_active' | 'skipped_low_disk' | 'failed';
  backupId?: string;
  prunedCount?: number;
  detail?: string;
}

export interface ScheduledBackupRunReport {
  entries: ScheduledBackupRunEntry[];
}

/**
 * Cheap due-peek (no journal, no side effects): is a scheduled backup due for
 * this instance right now? Used by the web scheduler loop to avoid creating
 * an operation record on every idle tick.
 */
export async function instanceHasDueScheduledBackup(
  deps: ActionDeps,
  instanceId: string,
  now: Date = new Date(),
): Promise<boolean> {
  let policy: BackupSchedulePolicy | undefined;
  try {
    policy = (await new ManifestStore(instanceId, deps.root).read()).backupSchedule;
  } catch {
    return false; // broken manifest: never attempt a backup blind
  }
  if (!policy || !policy.enabled) return false;
  const state = (await readSchedulerState(deps.root)).instances[instanceId];
  return isBackupDue(policy, state ? new Date(state.lastRunAt) : null, now);
}

/**
 * Takes ONE instance's due scheduled backup (disk preflight, backup tagged
 * `scheduled`, GFS prune) and records the attempt. Every attempted occurrence
 * (success, failure, low-disk skip) is marked covered, so the next attempt
 * happens at the NEXT scheduled occurrence — a failing nightly backup never
 * retries in a tight loop, and a manager that was down catches up exactly
 * once. Re-checks dueness itself, so concurrent callers (web loop vs cron)
 * cover an occurrence only once.
 */
export async function instanceRunScheduledBackup(
  deps: ActionDeps,
  instanceId: string,
  opts: { now?: Date; log?: (line: string) => void } = {},
): Promise<ScheduledBackupRunEntry> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (deps.now ? new Date(deps.now()) : new Date());

  const policy = (await new ManifestStore(instanceId, deps.root).read()).backupSchedule;
  if (!policy || !policy.enabled) {
    return { instanceId, action: 'skipped_not_due', detail: 'no enabled backup schedule' };
  }

  // Re-read the state at run time so a concurrent run (web loop vs cron)
  // observes the freshest lastRunAt and the occurrence is covered once.
  const instanceState = (await readSchedulerState(deps.root)).instances[instanceId];
  if (!isBackupDue(policy, instanceState ? new Date(instanceState.lastRunAt) : null, now)) {
    return { instanceId, action: 'skipped_not_due' };
  }

  const record = async (s: SchedulerInstanceState): Promise<void> => {
    const fresh = await readSchedulerState(deps.root);
    fresh.instances[instanceId] = s;
    await writeSchedulerState(deps.root, fresh);
  };

  // Disk budget: require 2x the newest backup size (or the floor) free.
  const { entries: existing } = await listInstanceBackups(deps, instanceId);
  const footprint = estimateFootprint(policy.retention, existing.map((e) => e.totalBytes));
  const requiredFree = Math.max(footprint.requiredFreeBytes, MIN_FREE_BYTES_FOR_SCHEDULED_BACKUP);
  try {
    const facts = await deps.resourceFacts([]);
    if (facts.diskBytesFree < requiredFree) {
      const detail =
        `free disk ${Math.round(facts.diskBytesFree / 1024 / 1024)} MiB is below the required ` +
        `${Math.round(requiredFree / 1024 / 1024)} MiB — backup skipped, will retry at the next occurrence`;
      log(`Scheduled backup for ${instanceId} skipped: ${detail}.`);
      await record({ lastRunAt: now.toISOString(), lastResult: 'skipped_low_disk', lastDetail: detail });
      return { instanceId, action: 'skipped_low_disk', detail };
    }
  } catch {
    // Resource probing unavailable: proceed — the backup itself will fail
    // loudly if the disk is actually full.
  }

  try {
    const backup = await instanceBackup(deps, instanceId, { mode: 'online', origin: 'scheduled' });
    const prune = await instanceBackupPrune(deps, instanceId, { now });
    log(`Scheduled backup ${backup.backupId} for ${instanceId} done (${prune.deleted.length} pruned).`);
    await record({ lastRunAt: now.toISOString(), lastResult: 'succeeded', lastBackupId: backup.backupId });
    return { instanceId, action: 'backup_taken', backupId: backup.backupId, prunedCount: prune.deleted.length };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`Scheduled backup for ${instanceId} FAILED: ${detail}`);
    await record({ lastRunAt: now.toISOString(), lastResult: 'failed', lastDetail: detail });
    return { instanceId, action: 'failed', detail };
  }
}

/**
 * Runs every instance's due scheduled backup, then prunes by the retention
 * policy. One-shot and idle-safe: instances without an enabled policy are
 * ignored and covered occurrences are skipped. Used by cron / systemd timers;
 * the persistent web server runs the same per-instance path through its
 * journaled scheduler loop.
 */
export async function serverRunScheduledBackups(
  deps: ActionDeps,
  opts: { now?: Date; log?: (line: string) => void } = {},
): Promise<ScheduledBackupRunReport> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (deps.now ? new Date(deps.now()) : new Date());
  const entries: ScheduledBackupRunEntry[] = [];

  let inventory;
  try {
    inventory = await new InventoryStore(deps.root).read();
  } catch {
    log('Scheduled backups: server not initialized yet — nothing to do.');
    return { entries };
  }

  for (const instance of inventory.instances) {
    const instanceId = instance.instanceId;
    let policy: BackupSchedulePolicy | undefined;
    try {
      policy = (await new ManifestStore(instanceId, deps.root).read()).backupSchedule;
    } catch (err) {
      // Broken manifest: no policy can be read; never attempt a backup blind.
      log(`Scheduled backups: cannot read manifest of ${instanceId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!policy || !policy.enabled) continue;

    if (instance.status !== 'active') {
      entries.push({ instanceId, action: 'skipped_not_active', detail: `instance status is "${instance.status}"` });
      continue;
    }

    entries.push(await instanceRunScheduledBackup(deps, instanceId, { now, log }));
  }

  return { entries };
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
  /** Fires as each restore stage starts so the BFF can advance the live UI. */
  onStep?: (step: OperationProgress) => void | Promise<void>;
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
  pluginsRemounted?: boolean;
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

  const step = async (phase: string, detail: string): Promise<void> => {
    try {
      await opts.onStep?.({ phase, detail });
    } catch {
      // Progress reporting is best-effort; never let it abort a restore.
    }
  };

  // Recompute hashes for integrity verification.
  await step('verify', 'Verifying backup integrity (recomputing checksums)…');
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
  await step('stop', 'Stopping the instance (volumes kept)…');
  await deps.runner.run(paths.dir, composeCommands.stop());

  // 2. Restore persistent volumes from the backup archives (when present).
  await step('volumes', 'Restoring uploads & plugin artifacts…');
  const uploadsTgz = path.join(backupDir, 'uploads.tgz');
  if (await pathExists(uploadsTgz)) await deps.extractVolume(uploadsTgz, `${project}_uploads`);
  const pluginTgz = path.join(backupDir, 'plugin_artifacts.tgz');
  if (await pathExists(pluginTgz)) await deps.extractVolume(pluginTgz, `${project}_plugin_artifacts`);
  const pluginPublicTgz = path.join(backupDir, 'plugin_artifacts_public.tgz');
  if (await pathExists(pluginPublicTgz)) {
    await deps.extractVolume(pluginPublicTgz, `${project}_plugin_artifacts_public`);
  }

  // 3. Start MySQL only, wait until ready, import the database dump.
  await step('database', 'Starting database & importing the dump…');
  await deps.runner.run(paths.dir, [...composeCommands.upDetached(), 'mysql']);
  await waitForMysqlReady(deps, paths.dir);
  await importDatabaseWithRetry(deps, paths.dir, path.join(backupDir, 'database.sql'));

  // 4. Restore configuration. A same-instance restore re-applies the point-in-time
  // compose (so code matches the restored DB). A clone/DR import keeps the current
  // code (so an older DB can be migrated forward) and rebuilds routing/compose for
  // its new production domain when one was given.
  await step('config', 'Restoring configuration & inventory…');
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
  await step('recreate', 'Starting the restored stack…');
  await deps.runner.run(paths.dir, composeCommands.upDetached());

  // 7. Migrate only when needed: the restored DB head differs from the running
  // code's head (i.e. current code was kept rather than the backup's compose).
  const restoredHead = restoredLock.core.migrationVersion;
  const migrated = !restoreCompose && preRestoreHead !== undefined && restoredHead !== preRestoreHead;
  if (migrated) {
    await step('migrate', 'Forward-migrating the restored database…');
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

  // 7b. Re-mount plugins. The restored DB lists the instance's plugins as
  // installed and the plugin_artifacts volumes were repopulated above, but the
  // freshly (re)created Symfony containers start WITHOUT the composer-installed
  // bundles mounted — exactly like an address/mailer/env recreate. Without this
  // the host reports "plugin could not be mounted / runtime import failed" and
  // the instance is left in a half-restored state (DB says installed, runtime
  // not loaded). Re-extract the composer-state snapshot from the plugin volume
  // into backend/worker/scheduler and restart them so the plugin runtime and
  // its public ESM artifacts are served again. Best-effort (never throws).
  const pluginsRemounted = await restorePluginStateAfterRecreate(
    deps,
    instanceId,
    restoredManifest.versions.selfhelp,
  );

  // 8. Health.
  await step('health', 'Health check…');
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
    pluginsRemounted,
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
  /**
   * Operator-facing display name for the clone. Defaults to the clone's own id
   * (NOT the source's name) so a clone is named after itself, not its origin.
   */
  displayName?: string;
  /**
   * Live progress hook: invoked at each clone milestone so the manager journal
   * can advance its phase + stream the log in real time. Best-effort: a throwing
   * hook never breaks the clone.
   */
  onPhase?: (phase: string, detail?: string) => void | Promise<void>;
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

  // Best-effort live progress: never let a reporting hook break the clone.
  const phase = async (name: string, detail?: string): Promise<void> => {
    if (!opts.onPhase) return;
    try {
      await opts.onPhase(name, detail);
    } catch {
      // Progress reporting must never break the clone.
    }
  };

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
    // Name the clone after itself, not its source: a clone of "prod" called
    // "staging" should read "staging" everywhere, not the source's display name.
    displayName: opts.displayName ?? targetInstanceId,
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
    pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
    // A clone behaves like its source, including operator env overrides.
    ...(sourceManifest.envOverrides ? { envOverrides: sourceManifest.envOverrides } : {}),
  });

  // A clone is a distinct security boundary: generate fresh secrets that share
  // nothing with the source, write the target artifacts + inventory entry, but
  // do not bring it up yet (we populate volumes + DB first).
  await phase('secrets', `Generating fresh secrets and writing clone config for "${targetInstanceId}".`);
  const secrets = generateCloneSecrets(secretGenOptions(deps));
  const secretsWritten = await writeInstanceSecrets(targetPaths.secretsDir, secrets, deps.secretIO);
  // Carry the source's admin bootstrap password (the "admin sector") into the
  // clone. The DB copy below brings the admin user + hash; this keeps the
  // password retrievable for the clone via `instance admin-password`.
  const clonedAdminPasswordFile = await copyAdminPasswordToClone(deps, sourceInstanceId, targetInstanceId);
  if (clonedAdminPasswordFile) secretsWritten.push(clonedAdminPasswordFile);
  await installInstance(artifacts, {
    root: deps.root,
    runner: deps.runner,
    bringUp: false,
    secrets,
    secretIO: deps.secretIO,
  });

  // Copy persistent volumes from the source (read-only) into the new target volumes.
  if (plan.copyUploads || plan.copyPluginArtifacts) {
    await phase('volumes', 'Copying uploads and plugin artifacts from the source (read-only).');
  }
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
  await phase('database', 'Copying the database from the source into the clone (source stays running).');
  await deps.runner.run(targetPaths.dir, [...composeCommands.upDetached(), 'mysql']);
  await waitForMysqlReady(deps, targetPaths.dir);
  const { stdout: dump } = await deps.runner.run(sourcePaths.dir, ['exec', '-T', 'mysql', 'sh', '-lc', APP_DB_DUMP_CMD]);
  await mkdir(targetPaths.backupsDir, { recursive: true });
  const tmpDump = path.join(targetPaths.backupsDir, 'clone-source.sql');
  await writeFile(tmpDump, dump);
  await importDatabaseWithRetry(deps, targetPaths.dir, tmpDump);
  await rm(tmpDump, { force: true });

  // Bring the full clone stack up and health-check it.
  await phase('recreate', 'Starting the full clone stack.');
  await deps.runner.run(targetPaths.dir, composeCommands.upDetached());
  await phase('health', 'Running health checks on the clone.');
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
    pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
    // Keep operator env overrides across an address change.
    ...(manifest.envOverrides ? { envOverrides: manifest.envOverrides } : {}),
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
    // Re-applying a production address is the operator's natural "fix routing"
    // action — make sure the shared proxy is actually running, not just the
    // instance, so a server whose proxy never started becomes reachable.
    await ensureProxyRunning(deps, manifest.mode);
    await deps.runner.run(paths.dir, composeCommands.upDetached());
    // Recreated Symfony containers lose their composer-installed plugins;
    // restore them from the snapshot on the plugin volume (no-op when intact).
    await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
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
// instance rename (change the operator-facing display name only)
// ---------------------------------------------------------------------------

export interface SetNameOptions {
  /** New operator-facing display name (the instanceId is never changed). */
  displayName: string;
}

export interface SetNameResult {
  changed: boolean;
  previousName: string;
  displayName: string;
}

/**
 * Renames an instance's operator-facing DISPLAY NAME only.
 *
 * The `instanceId` is the immutable technical key — it names the Compose
 * project, the on-disk directory, the Docker volumes/network and the routing —
 * so renaming *it* would have to recreate every Docker resource and migrate all
 * data; that is deliberately out of scope. A display-name change is metadata
 * only: it atomically rewrites the manifest (and regenerates the operator
 * README so it matches), with NO container restart and no data risk. This is
 * the rename operators want after a clone or a domain change.
 */
export async function instanceSetName(
  deps: ActionDeps,
  instanceId: string,
  opts: SetNameOptions,
): Promise<SetNameResult> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const displayName = opts.displayName.trim();
  if (displayName === '') {
    throw new Error('A display name is required (it cannot be empty).');
  }
  if (displayName.length > 200) {
    throw new Error('Display name is too long (max 200 characters).');
  }
  const previousName = manifest.displayName;
  const changed = displayName !== previousName;

  const updated: InstanceManifest = {
    ...manifest,
    displayName,
    updatedAt: deps.now?.() ?? new Date().toISOString(),
  };
  await new ManifestStore(instanceId, deps.root).write(updated);

  // Keep the generated operator README in sync (it prints the display name).
  const paths = instancePaths(instanceId, deps.root);
  await writeFileAtomic(
    paths.readmePath,
    generateInstanceReadme(updated, { managerVersion: deps.managerVersion, root: deps.root }),
  );

  return { changed, previousName, displayName };
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
// instance enable (bring a disabled / removed-keep-data instance back online)
// ---------------------------------------------------------------------------

export interface EnableResult extends EnablePlan {
  executed: boolean;
  /** Post-start health probe, when the manifest was readable. */
  health?: HealthReport;
}

/**
 * Re-enables a stopped instance — the inverse of the `disable` removal mode.
 *
 * `docker compose up -d` starts the stopped containers of a `disabled` instance
 * and recreates the removed containers of a `removed_keep_data` one; either way
 * all volumes/secrets/config are still on disk, so the instance comes back with
 * its data intact. After a recreate the composer-installed plugins are remounted
 * from the plugin volume snapshot (no-op when intact). The inventory status is
 * flipped back to `active` and a best-effort health probe is returned.
 */
export async function instanceEnable(deps: ActionDeps, instanceId: string): Promise<EnableResult> {
  const store = new InventoryStore(deps.root);
  const inventory = await store.read();
  const plan = planEnable({ instanceId }, inventory);
  if (!plan.ok) return { ...plan, executed: false };

  const paths = instancePaths(instanceId, deps.root);
  const manifest = await new ManifestStore(instanceId, deps.root).read().catch(() => null);

  // The compose declares the shared proxy network as external; make sure it
  // exists (servers bootstrapped before multi-instance support, or a restarted
  // Docker daemon, may not have it yet).
  if (deps.ensureNetwork) {
    await deps.ensureNetwork(inventory.proxy.network ?? DEFAULT_PROXY_NETWORK);
  }
  // Re-enabling a production instance is pointless if the shared proxy is down;
  // bring it up too so the instance is actually reachable again.
  if (manifest) await ensureProxyRunning(deps, manifest.mode);

  // Bring the instance back: starts a stopped (disabled) stack or recreates a
  // downed (removed_keep_data) one — never `-v`, so no volume is touched.
  await deps.runner.run(paths.dir, composeCommands.upDetached());

  // A recreate drops composer-installed plugins from the Symfony containers'
  // writable layer; restore them from the plugin volume snapshot so the CMS
  // keeps its plugins (no-op when none are installed / already intact).
  if (manifest) {
    await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
  }

  // Flip inventory status back to active.
  const entry = inventory.instances.find((i) => i.instanceId === instanceId);
  if (entry) {
    entry.status = plan.newStatus;
    await store.write(inventory);
  }

  // Best-effort health probe so the operator immediately sees it came back; a
  // slow first start must never fail the (already successful) enable itself.
  let health: HealthReport | undefined;
  if (manifest) {
    try {
      health = evaluateHealth(
        instanceId,
        await deps.probeHealth(manifest.routing.publicFrontendUrl, manifest.routing.browserApiPrefix),
        deps.now,
      );
    } catch {
      health = undefined;
    }
  }

  return { ...plan, executed: true, ...(health ? { health } : {}) };
}

// ---------------------------------------------------------------------------
// instance set-mailer (operator SMTP DSN, stored in secrets.env)
// ---------------------------------------------------------------------------

export interface SetMailerOptions {
  /** SMTP DSN, e.g. `smtp://user:pass@mail.example.org:587`. */
  dsn?: string;
  /** Remove the override; the instance falls back to Mailpit/image default. */
  clear?: boolean;
  /** Recreate containers so the new DSN takes effect (default true). */
  restart?: boolean;
}

export interface MailerStatus {
  /** True when an operator DSN override is configured. */
  configured: boolean;
  /** Credential-redacted DSN for display; never the raw value. */
  redactedDsn?: string;
}

/** Reads the instance's mailer configuration (redacted, never raw). */
export async function instanceGetMailer(deps: ActionDeps, instanceId: string): Promise<MailerStatus> {
  await readManifestFriendly(deps, instanceId);
  const paths = instancePaths(instanceId, deps.root);
  const secrets = await readInstanceSecrets(paths.secretsDir);
  if (!secrets?.mailerDsn) return { configured: false };
  return { configured: true, redactedDsn: redactMailerDsn(secrets.mailerDsn) };
}

/**
 * Sets or clears the instance's outbound-mail DSN. The DSN lives in the 0600
 * `secrets.env` (it may carry SMTP credentials) and overrides the non-secret
 * Mailpit default. By default the stack is recreated so backend/worker/
 * scheduler pick the new value up immediately.
 */
export async function instanceSetMailer(
  deps: ActionDeps,
  instanceId: string,
  opts: SetMailerOptions,
): Promise<MailerStatus & { restarted: boolean }> {
  const manifest = await readManifestFriendly(deps, instanceId);
  if (!opts.clear && (!opts.dsn || opts.dsn.trim() === '')) {
    throw new Error('Provide a mailer DSN (e.g. smtp://user:pass@mail.example.org:587) or --clear.');
  }
  const dsn = opts.clear ? '' : opts.dsn!.trim();
  if (dsn !== '' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(dsn)) {
    throw new Error(`"${dsn}" is not a valid mailer DSN (expected scheme://…, e.g. smtp://host:587).`);
  }

  const paths = instancePaths(instanceId, deps.root);
  const existing = await readInstanceSecrets(paths.secretsDir);
  if (!existing) {
    throw new Error(`Instance "${instanceId}" has no secrets directory; was it installed by this manager?`);
  }
  const updated = withMailerDsn(existing, dsn);
  await writeInstanceSecrets(paths.secretsDir, updated, deps.secretIO);

  const restart = opts.restart ?? true;
  if (restart) {
    // `up -d` recreates only the services whose env_file content changed.
    await deps.runner.run(paths.dir, composeCommands.upDetached());
    // Recreated Symfony containers lose their composer-installed plugins;
    // restore them from the snapshot on the plugin volume (no-op when intact).
    await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
  }
  return {
    configured: dsn !== '',
    ...(dsn !== '' ? { redactedDsn: redactMailerDsn(dsn) } : {}),
    restarted: restart,
  };
}

// ---------------------------------------------------------------------------
// instance environment editor (non-secret .env)
// ---------------------------------------------------------------------------

export interface InstanceEnvEntry {
  key: string;
  /** Effective value currently in the live `.env`. */
  value: string;
  /**
   * Manager-generated default for this key (before overrides). Absent for
   * operator-added custom keys. Lets the editor show "modified vs default" and
   * offer a one-click reset.
   */
  defaultValue?: string;
  /** Manager-owned structural key (read-only; see MANAGER_CONTROLLED_ENV_KEYS). */
  managed: boolean;
  /** Operator added this key (not part of the generated base env). */
  custom: boolean;
  /** An operator override is currently in effect for this key. */
  overridden: boolean;
}

export interface InstanceEnvConfig {
  instanceId: string;
  /** Effective `.env` entries (the live non-secret runtime config). */
  entries: InstanceEnvEntry[];
  /** Keys the editor must render read-only. */
  managedKeys: string[];
}

export interface SetEnvOptions {
  /**
   * Full set of operator overrides to persist (replaces the previous set).
   * Structural keys are rejected; secrets must never be sent here.
   */
  overrides: Record<string, string>;
  /** Recreate containers so the new values take effect (default true). */
  restart?: boolean;
}

export interface SetEnvResult {
  applied: number;
  restarted: boolean;
  health?: HealthReport;
}

/** Builds the env input that mirrors what install/update generate for this instance. */
function envInputFromManifest(deps: ActionDeps, manifest: InstanceManifest) {
  return {
    instanceId: manifest.instanceId,
    mode: manifest.mode,
    selfhelpVersion: manifest.versions.selfhelp,
    frontendVersion: manifest.versions.frontend,
    publicFrontendUrl: manifest.routing.publicFrontendUrl,
    registryUrl: manifest.registry.url,
    pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
  };
}

/**
 * Reads an instance's non-secret environment. The values come from the live
 * `.env` (secrets live in `secrets.env`, which is NEVER read here), classified
 * so the UI can render manager-owned keys read-only and operator-set keys as
 * editable.
 */
export async function instanceGetEnv(deps: ActionDeps, instanceId: string): Promise<InstanceEnvConfig> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const paths = instancePaths(instanceId, deps.root);
  const fileEnv = parseDotEnv(await readFile(paths.envPath, 'utf8').catch(() => ''));
  // Generated baseline (no overrides): tells us each key's default + which keys
  // are operator-added "custom" ones.
  const baseEnv = buildInstanceEnv(envInputFromManifest(deps, manifest));
  const overrides = manifest.envOverrides ?? {};

  const entries: InstanceEnvEntry[] = Object.entries(fileEnv)
    .map(([key, value]) => {
      const defaultValue = baseEnv[key];
      return {
        key,
        value,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        managed: MANAGER_CONTROLLED_ENV_KEYS.includes(key),
        custom: defaultValue === undefined,
        overridden: Object.prototype.hasOwnProperty.call(overrides, key),
      };
    })
    .sort((a, b) => {
      // Editable first, managed last; alphabetical within each group.
      if (a.managed !== b.managed) return a.managed ? 1 : -1;
      return a.key.localeCompare(b.key);
    });

  return { instanceId, entries, managedKeys: [...MANAGER_CONTROLLED_ENV_KEYS] };
}

/**
 * Persists operator env overrides and regenerates the instance `.env`. The
 * overrides live on the manifest so they survive every later regeneration
 * (update/clone/address-change). Structural keys are refused, and the stack is
 * recreated by default so all services pick up the change.
 */
export async function instanceSetEnv(deps: ActionDeps, instanceId: string, opts: SetEnvOptions): Promise<SetEnvResult> {
  const manifest = await readManifestFriendly(deps, instanceId);

  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(opts.overrides ?? {})) {
    const key = rawKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`"${rawKey}" is not a valid environment variable name (use letters, digits, and underscores; cannot start with a digit).`);
    }
    if (MANAGER_CONTROLLED_ENV_KEYS.includes(key)) {
      throw new Error(`${key} is managed by the manager and cannot be edited here${key === 'MAILER_DSN' ? ' — use the outbound-email settings instead' : ''}.`);
    }
    const value = String(rawValue);
    if (/[\r\n]/.test(value)) {
      throw new Error(`The value for ${key} must be a single line (no newlines).`);
    }
    sanitized[key] = value;
  }

  const lockStore = new LockStore(instanceId, deps.root);
  const lock = await lockStore.read();
  const { core, frontend } = releaseShapesFromLock(manifest, lock, 'env-change');
  const paths = instancePaths(instanceId, deps.root);
  const localPort =
    manifest.mode === 'local' ? Number(new URL(manifest.routing.publicFrontendUrl).port) : undefined;

  const artifacts = buildInstanceInstallArtifacts({
    instanceId,
    displayName: manifest.displayName,
    mode: manifest.mode,
    ...(manifest.mode === 'production' ? { domain: manifest.domain } : { localPort: localPort! }),
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
    pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
    envOverrides: sanitized,
  });

  // Only the .env content depends on the overrides; the compose/readme are
  // unchanged, so we write just the .env and the manifest (which now records
  // the overrides). Atomic writes never corrupt the running instance.
  await writeFileAtomic(paths.envPath, artifacts.envText);
  await new ManifestStore(instanceId, deps.root).write({
    ...artifacts.manifest,
    createdAt: manifest.createdAt,
    updatedAt: deps.now?.() ?? new Date().toISOString(),
  });

  const restart = opts.restart ?? true;
  let health: HealthReport | undefined;
  if (restart) {
    await deps.runner.run(paths.dir, composeCommands.upDetached());
    // Recreated Symfony containers lose their composer-installed plugins;
    // restore them from the snapshot on the plugin volume (no-op when intact).
    await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
    health = evaluateHealth(
      instanceId,
      await deps.probeHealth(manifest.routing.publicFrontendUrl, manifest.routing.browserApiPrefix),
      deps.now,
    );
  }

  return {
    applied: Object.keys(sanitized).length,
    restarted: restart,
    ...(health ? { health } : {}),
  };
}

// ---------------------------------------------------------------------------
// server purge (remove EVERYTHING this manager created)
// ---------------------------------------------------------------------------

export interface ServerPurgeOptions {
  /** Must equal `purge selfhelp`. */
  confirm?: string;
  /** Also delete every instance's backups (default: keep them). */
  deleteBackups?: boolean;
}

export interface ServerPurgeReport {
  ok: boolean;
  errors: string[];
  instancesRemoved: string[];
  proxyRemoved: boolean;
  networkRemoved: boolean;
  /** State files/dirs deleted under the root. */
  removedPaths: string[];
  /** Paths intentionally preserved (backups unless --delete-backups). */
  keptPaths: string[];
}

/**
 * Full teardown of a SelfHelp server: every instance (containers + volumes +
 * folders), the shared Traefik proxy, the proxy network, and the manager's
 * server state files. The ONE deliberately destructive command — it demands
 * the typed confirmation `purge selfhelp` and still keeps per-instance
 * backups unless `--delete-backups` is passed. After a purge, `server init`
 * starts from a clean slate.
 */
export async function serverPurge(deps: ActionDeps, opts: ServerPurgeOptions): Promise<ServerPurgeReport> {
  const report: ServerPurgeReport = {
    ok: false,
    errors: [],
    instancesRemoved: [],
    proxyRemoved: false,
    networkRemoved: false,
    removedPaths: [],
    keptPaths: [],
  };
  if (opts.confirm !== 'purge selfhelp') {
    report.errors.push('Confirmation mismatch: pass --confirm "purge selfhelp" to proceed.');
    return report;
  }

  const inventoryStore = new InventoryStore(deps.root);
  const inventory = await inventoryStore.read().catch(() => null);

  // 1. Every registered instance: full delete (containers, volumes, folder).
  for (const entry of inventory?.instances ?? []) {
    try {
      const res = await instanceRemove(deps, entry.instanceId, {
        mode: 'full_delete',
        deleteVolumes: true,
        deleteBackups: opts.deleteBackups ?? false,
        confirm: `delete ${entry.instanceId}`,
      });
      if (!res.executed) {
        report.errors.push(`${entry.instanceId}: ${res.errors.join('; ')}`);
        continue;
      }
      report.instancesRemoved.push(entry.instanceId);
      if (!(opts.deleteBackups ?? false)) {
        report.keptPaths.push(instancePaths(entry.instanceId, deps.root).backupsDir);
      }
    } catch (err) {
      report.errors.push(`${entry.instanceId}: ${errMessage(err)}`);
    }
  }

  // 2. Shared proxy: compose down (Traefik holds no instance data), then the
  //    proxy folder and network.
  const proxy = proxyDir(deps.root);
  try {
    if (await pathExists(path.join(proxy, 'compose.yaml'))) {
      await deps.runner.run(proxy, composeCommands.down());
      report.proxyRemoved = true;
    }
    await rm(proxy, { recursive: true, force: true });
    report.removedPaths.push(proxy);
  } catch (err) {
    report.errors.push(`proxy: ${errMessage(err)}`);
  }
  const network = inventory?.proxy.network ?? DEFAULT_PROXY_NETWORK;
  if (deps.removeNetwork) {
    try {
      await deps.removeNetwork(network);
      report.networkRemoved = true;
    } catch (err) {
      report.errors.push(`network ${network}: ${errMessage(err)}`);
    }
  }

  // 3. Server state files. The instances/ tree stays when backups are kept.
  for (const rel of ['selfhelp.server.json', 'selfhelp.server.json.bak']) {
    const file = path.join(deps.root, rel);
    if (await pathExists(file)) {
      await rm(file, { force: true });
      report.removedPaths.push(file);
    }
  }
  if (opts.deleteBackups ?? false) {
    const instancesDir = path.join(deps.root, 'instances');
    await rm(instancesDir, { recursive: true, force: true });
    report.removedPaths.push(instancesDir);
  }

  // 4. Manager state: operators, operation journal, locks, poller state — a
  //    purged server starts over at the first-run setup. The audit log is the
  //    one record deliberately kept (the purge itself should stay traceable).
  const managerDir = path.join(deps.root, 'manager');
  if (await pathExists(managerDir)) {
    const auditFile = path.join(managerDir, 'audit.jsonl');
    const keepAudit = await pathExists(auditFile);
    for (const entry of await readdir(managerDir).catch(() => [] as string[])) {
      if (keepAudit && entry === 'audit.jsonl') continue;
      await rm(path.join(managerDir, entry), { recursive: true, force: true });
      report.removedPaths.push(path.join(managerDir, entry));
    }
    if (keepAudit) report.keptPaths.push(auditFile);
  }

  report.ok = report.errors.length === 0;
  return report;
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
// instance logs (read recent container logs on demand, redacted)
// ---------------------------------------------------------------------------

/**
 * Services whose container logs an operator can read from the manager. Ordered
 * for the UI picker; `volume-init` is intentionally excluded (a one-shot init
 * container with no useful runtime log).
 */
export const LOG_SERVICES = [
  'backend',
  'frontend',
  'worker',
  'scheduler',
  'mysql',
  'redis',
  'mercure',
  'mailpit',
] as const;
export type LogService = (typeof LOG_SERVICES)[number];

/** Bounds for the `--tail` line count (UI default: 200). */
const LOG_TAIL_MIN = 1;
const LOG_TAIL_MAX = 2000;
const LOG_TAIL_DEFAULT = 200;

export interface InstanceLogsResult {
  instanceId: string;
  service: LogService;
  /** Number of trailing lines requested (after clamping). */
  tail: number;
  /** Redacted log text — the running container's stdout/stderr. */
  text: string;
  /** ISO timestamp the logs were read at (for the UI). */
  readAt: string;
}

function clampLogTail(tail: number | undefined): number {
  if (tail === undefined || !Number.isFinite(tail)) return LOG_TAIL_DEFAULT;
  return Math.max(LOG_TAIL_MIN, Math.min(LOG_TAIL_MAX, Math.floor(tail)));
}

/**
 * Turns a `docker compose logs <service>` failure into an operator-readable
 * message. Compose's own "no such service" is the common, confusing case: the
 * requested service is simply not part of THIS instance's compose project
 * (e.g. `mailpit`, which only exists for local-mode instances that use the
 * bundled test mailbox, or any service on an instance whose compose predates a
 * later-added service). Translate it instead of surfacing the raw error.
 */
function logReadFailureMessage(service: LogService, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (/no such service/i.test(detail)) {
    if (service === 'mailpit') {
      return (
        `This instance has no "mailpit" service. Mailpit is the bundled test mailbox that only runs ` +
        `for local-mode instances; it is a sink and never relays mail to a real server. To send real ` +
        `outbound mail (e.g. through a campus/UniBE relay without a password), set the instance's SMTP ` +
        `DSN in the mailer settings — for example smtp://smtp.unibe.ch:25 — rather than reading mailpit logs.`
      );
    }
    return `This instance has no "${service}" service, so there are no logs to read for it.`;
  }
  return `Could not read logs for "${service}": ${detail}`;
}

/**
 * Reads the recent container logs for ONE service of an instance via
 * `docker compose logs --tail=<n> <service>`, redacting any secret-looking
 * content before returning.
 *
 * These are the running container's stdout/stderr — exactly what Symfony (backend)
 * and Next.js (frontend) print on error — surfaced on demand so an operator can
 * diagnose an instance from the manager without shelling into the server. It is
 * the same source the support bundle captures.
 *
 * Note on persistence: Docker keeps these logs for the lifetime of the container,
 * so they survive a restart but are reset when the container is recreated (e.g. by
 * an update). For a portable, point-in-time copy use the support bundle before a
 * risky change.
 */
export async function instanceLogs(
  deps: ActionDeps,
  instanceId: string,
  opts: { service?: LogService; tail?: number } = {},
): Promise<InstanceLogsResult> {
  const service: LogService = opts.service ?? 'backend';
  if (!LOG_SERVICES.includes(service)) {
    throw new Error(`Unknown service "${service}". Choose one of: ${LOG_SERVICES.join(', ')}.`);
  }
  const tail = clampLogTail(opts.tail);
  // Confirm the instance exists first, so a bad id is a clear error rather than a
  // raw compose failure.
  await readManifestFriendly(deps, instanceId);
  const paths = instancePaths(instanceId, deps.root);
  const raw = await deps.runner
    .run(paths.dir, [...composeCommands.logs(tail), service])
    .then((r) => r.stdout || r.stderr)
    .catch((err: unknown) => logReadFailureMessage(service, err));
  return {
    instanceId,
    service,
    tail,
    text: redactString(raw),
    readAt: deps.now?.() ?? new Date().toISOString(),
  };
}

export interface ProxyLogsResult {
  /** Number of trailing lines requested (after clamping). */
  tail: number;
  /** Redacted Traefik log text. */
  text: string;
  /** ISO timestamp the logs were read at. */
  readAt: string;
}

/**
 * Reads the shared Traefik proxy's recent logs via
 * `docker compose -f <root>/proxy/compose.yaml logs --tail=<n>`, redacted.
 *
 * Surfaced in the manager (CLI `server logs`, web console) so an operator can
 * diagnose edge/routing/TLS problems — e.g. the Docker-provider "client version
 * 1.24 is too old" failure, ACME/Let's Encrypt errors, or "no router for host" —
 * without shelling into the server. A no-op-safe message is returned (never a
 * throw) when the proxy has not been started yet.
 */
export async function serverProxyLogs(deps: ActionDeps, opts: { tail?: number } = {}): Promise<ProxyLogsResult> {
  const tail = clampLogTail(opts.tail);
  const raw = await deps.runner
    .run(proxyDir(deps.root), composeCommands.logs(tail))
    .then((r) => r.stdout || r.stderr)
    .catch((err: unknown) => `Could not read proxy logs: ${err instanceof Error ? err.message : String(err)}`);
  return {
    tail,
    text: redactString(raw),
    readAt: deps.now?.() ?? new Date().toISOString(),
  };
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
