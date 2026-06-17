// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared internals for the CLI action modules.
 *
 * `ActionDeps` (the injected side-effect boundary) plus the cross-cutting
 * helpers reused by more than one action domain (registry client, MySQL
 * readiness, instance-state discovery, friendly manifest reads, plugin seams,
 * proxy bring-up, admin-password persistence, backup file hashing). Each action
 * module imports the helpers it needs from here; only the genuinely public
 * symbols (`ActionDeps`, `ensureProxyRunning`, `ADMIN_PASSWORD_FILENAME`,
 * `PluginDrainOverrides`, `OperationProgress`) are re-exported by the barrel.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  CoreRelease,
  FrontendRelease,
  InstanceLock,
  InstanceManifest,
  InstanceMode,
  LockServiceEntry,
  RegistryReleaseRef,
  TrustedKeysFile,
} from '@shm/schemas';
import type { ComposeRunner } from '@shm/docker';
import { DEFAULT_PROXY_NETWORK, composeCommands, composeProjectName } from '@shm/docker';
import type { Fetcher } from '@shm/registry';
import { RegistryClient } from '@shm/registry';
import {
  buildServerBootstrap,
  restorePluginStateIfNeeded,
  type PendingPluginOperation,
  type PluginExecDeps,
  type PreflightResourceFacts,
  type ServiceProbeResult,
} from '@shm/core';
import {
  InventoryStore,
  ManifestStore,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
  instancePaths,
  nodeSecretIO,
  proxyDir,
  validateDomainForInstall,
  writeFileAtomic,
  type GenerateSecretsOptions,
  type InstancePaths,
  type SecretIO,
} from '@shm/instances';
import { ComposeExecPluginStateClient, composePluginExecDeps, type PluginStateClient } from '../plugin-state-client.js';

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

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * MySQL "Access denied" (SQLSTATE 1045 / ER_ACCESS_DENIED_ERROR) is a
 * credential mismatch, not slow startup, so retrying cannot fix it. It almost
 * always means the instance's mysql_data volume was initialised by an EARLIER
 * install with different generated secrets: the official mysql image applies
 * MYSQL_USER/MYSQL_PASSWORD only on the first initialisation of an empty
 * volume, so once secrets are regenerated the stack is locked out of its own
 * database forever.
 */
export function isDbCredentialError(message: string): boolean {
  return /access denied for user|SQLSTATE\[HY000\] \[1045\]|ERROR 1045/i.test(message);
}

/** Consecutive credential rejections tolerated before failing fast. */
export const DB_CREDENTIAL_FAILURE_LIMIT = 3;

export function dbCredentialMismatchError(instanceId: string, lastErr: unknown): Error {
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

export function secretGenOptions(deps: ActionDeps): GenerateSecretsOptions {
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
export async function waitForMysqlReady(deps: ActionDeps, instanceDir: string): Promise<void> {
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
export async function importDatabaseWithRetry(deps: ActionDeps, instanceDir: string, sqlFile: string): Promise<void> {
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

export const DEFAULT_SERVICE_IMAGES = { mysql: 'mysql:8.4', redis: 'redis:7.2', mercure: 'dunglas/mercure:v0.18' };

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
export const APP_DB_DUMP_CMD =
  'exec mysqldump --no-tablespaces --single-transaction --routines --triggers ' +
  '-uroot -p"$MYSQL_ROOT_PASSWORD" --databases ' +
  '$(mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SHOW DATABASES" ' +
  '| grep -Ev "^(mysql|sys|information_schema|performance_schema)$")';

export function registryClient(deps: ActionDeps, baseUrl: string): RegistryClient {
  return new RegistryClient({ baseUrl, trustedKeys: deps.trustedKeys, managerVersion: deps.managerVersion, fetcher: deps.fetcher });
}

export async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false);
}

/** True when the directory carries real instance state (not just retained backups). */
export async function looksLikeInstanceState(paths: InstancePaths): Promise<boolean> {
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
export async function readManifestFriendly(deps: ActionDeps, instanceId: string): Promise<InstanceManifest> {
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

export async function fetchAllFrontends(client: RegistryClient, refs: RegistryReleaseRef[], channel: string): Promise<FrontendRelease[]> {
  const wanted = refs.filter((r) => r.channel === channel && !r.blocked);
  const out: FrontendRelease[] = [];
  for (const r of wanted) out.push((await client.getFrontendRelease(r)).release);
  return out;
}

/**
 * Synthesises the minimal core/frontend release shapes the artifact builder
 * needs from an instance's manifest + lock — for offline operations (clone,
 * address change) that must pin the EXACT versions/digests already installed
 * instead of consulting the registry.
 */
export function releaseShapesFromLock(
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
export async function persistOrReuseAdminPassword(
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
export async function copyAdminPasswordToClone(
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
export async function assertInstallableDomain(
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

export function pluginSeams(
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

/**
 * Best-effort plugin-state restore after containers were recreated WITHOUT a
 * version change (address/mailer change, manual recreate): if the marker file
 * is gone but a composer-state snapshot exists on the plugin volume, extract
 * it into backend/worker/scheduler and restart them. Never throws — the
 * primary action (address/mailer/start) must not fail because of this.
 */
export async function restorePluginStateAfterRecreate(
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

export function sha256Hex(buf: Buffer): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

/** Minimal `.env` parser (KEY=VALUE, ignores comments/blank lines, strips quotes). */
export function parseEnv(text: string): Record<string, string> {
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

export async function hashFilesIn(dir: string, exclude: string[]): Promise<{ path: string; sha256: string; bytes: number }[]> {
  const names = (await readdir(dir)).filter((n) => !exclude.includes(n)).sort();
  const out: { path: string; sha256: string; bytes: number }[] = [];
  for (const name of names) {
    const buf = await readFile(path.join(dir, name));
    out.push({ path: name, sha256: sha256Hex(buf), bytes: buf.length });
  }
  return out;
}

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
