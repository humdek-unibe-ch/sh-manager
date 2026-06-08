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
import type {
  BackupManifest,
  CoreRelease,
  FrontendRelease,
  InstanceMode,
  LockServiceEntry,
  PluginRelease,
  RegistryReleaseRef,
  ReleaseChannel,
  TrustedKeysFile,
} from '@shm/schemas';
import type { ComposeRunner } from '@shm/docker';
import { composeCommands, composeProjectName } from '@shm/docker';
import type { Fetcher } from '@shm/registry';
import { RegistryClient } from '@shm/registry';
import {
  assertSafeToBootstrap,
  assessBootstrapTarget,
  buildInstanceInstallArtifacts,
  buildServerBootstrap,
  evaluateHealth,
  executeUpdate,
  installInstance,
  planUpdate,
  processNextOperation,
  provisionInstance,
  runPreflight,
  type BackendOperationsClient,
  type BootstrapTargetFacts,
  type HealthReport,
  type OperationExecutor,
  type PreflightResourceFacts,
  type ProcessOutcome,
  type ProvisionReport,
  type ServiceProbeResult,
  type UpdatePlan,
} from '@shm/core';
import {
  InventoryStore,
  LockStore,
  ManifestStore,
  generateCloneSecrets,
  instancePaths,
  instancesDir,
  planRemove,
  proxyDir,
  secretsForRestore,
  serverInventoryPath,
  validateDomainForInstall,
  writeFileAtomic,
  writeInstanceSecrets,
  type GenerateSecretsOptions,
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
  /** Archive a named Docker volume into `outFile` (real impl uses `docker run … tar`). */
  archiveVolume?: (volumeName: string, outFile: string) => Promise<void>;
  /** Delete named Docker volumes (full-delete only; real impl uses `docker volume rm`). */
  removeVolumes?: (volumeNames: string[]) => Promise<void>;
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

function secretGenOptions(deps: ActionDeps): GenerateSecretsOptions {
  return deps.jwtModulusLength === undefined ? {} : { jwtModulusLength: deps.jwtModulusLength };
}

const DEFAULT_SERVICE_IMAGES = { mysql: 'mysql:8.4', redis: 'redis:7.2', mercure: 'dunglas/mercure:0.18' };

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
  // operator explicitly acknowledges import/repair.
  assertSafeToBootstrap(assessBootstrapTarget(await discoverBootstrapTarget(deps.root)), {
    allowImport: opts.allowImport ?? false,
  });

  const boot = buildServerBootstrap({
    serverId: opts.serverId,
    managerVersion: deps.managerVersion,
    mode: opts.mode,
    root: deps.root,
    ...(opts.letsencryptEmail ? { letsencryptEmail: opts.letsencryptEmail } : {}),
    ...(opts.proxyNetwork ? { proxyNetwork: opts.proxyNetwork } : {}),
  });
  await writeFileAtomic(boot.proxyComposePath, boot.proxyComposeYaml);
  const store = new InventoryStore(deps.root);
  await store.write(boot.inventory);
  return { proxyComposePath: boot.proxyComposePath, inventoryPath: store.path };
}

// ---------------------------------------------------------------------------
// instance list
// ---------------------------------------------------------------------------

export async function instanceList(deps: ActionDeps): Promise<{ instanceId: string; domain: string; status: string; composeProject: string }[]> {
  const inv = await new InventoryStore(deps.root).read();
  return inv.instances.map((i) => ({ instanceId: i.instanceId, domain: i.domain, status: i.status, composeProject: i.composeProject }));
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
): Promise<{ instanceDir: string; version: string; broughtUp: boolean; provision?: ProvisionReport; adminPassword?: string; domainWarnings: string[] }> {
  // Fail fast on duplicate domains / bad DNS before touching the registry or disk.
  const domainWarnings = await assertInstallableDomain(deps, opts);

  const channel = opts.channel ?? 'stable';
  const client = registryClient(deps, opts.registryUrl);
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

  const publicFrontendUrl = opts.mode === 'production' ? `https://${opts.domain}` : `http://localhost:${opts.localPort}`;
  const artifacts = buildInstanceInstallArtifacts({
    instanceId: opts.instanceId,
    displayName: opts.displayName,
    mode: opts.mode,
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.localPort !== undefined ? { localPort: opts.localPort } : {}),
    root: deps.root,
    managerVersion: deps.managerVersion,
    channel,
    registry: { id: index.publisher.name, url: opts.registryUrl, metadataSha256: client.lastSuccessfulCheck?.metadataSha256 ?? '' },
    core,
    frontend,
    services,
    mercurePublicUrl: `${publicFrontendUrl}/.well-known/mercure`,
  });

  // Provisioning requires a running stack, so it implies bringUp.
  const bringUp = (opts.bringUp ?? false) || (opts.provision ?? false);
  const res = await installInstance(artifacts, { root: deps.root, runner: deps.runner, bringUp });

  if (!opts.provision) {
    return { instanceDir: res.instanceDir, version: core.version, broughtUp: res.broughtUp, domainWarnings };
  }

  // A generated admin password is returned to the caller exactly once and never
  // written to disk, the manifest, the lock, or any log.
  const generatedPassword =
    opts.adminEmail && !opts.adminPassword ? randomBytes(18).toString('base64url') : undefined;
  const provision = await runInstanceProvisioning(deps, opts, artifacts, core.version, generatedPassword);

  return {
    instanceDir: res.instanceDir,
    version: core.version,
    broughtUp: res.broughtUp,
    provision,
    domainWarnings,
    ...(generatedPassword ? { adminPassword: generatedPassword } : {}),
  };
}

/**
 * Duplicate-domain prevention + optional production DNS-binding check. Throws a
 * clear aggregated error when the domain cannot be installed; returns non-fatal
 * warnings (e.g. DNS not yet pointing here) for the caller to surface.
 */
async function assertInstallableDomain(deps: ActionDeps, opts: InstanceInstallOptions): Promise<string[]> {
  const existingDomains = await new InventoryStore(deps.root)
    .read()
    .then((inv) => inv.instances.map((e) => e.domain))
    .catch(() => [] as string[]);

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

  return provisionInstance(
    { instanceId: opts.instanceId, version },
    {
      waitForDatabase: async () => {
        const attempts = deps.dbWaitAttempts ?? 60;
        const delayMs = deps.dbWaitDelayMs ?? 2000;
        let lastErr: unknown;
        for (let i = 0; i < attempts; i++) {
          try {
            await consoleExec(['dbal:run-sql', 'SELECT 1']);
            return;
          } catch (err) {
            lastErr = err;
            if (i < attempts - 1) await sleep(delayMs);
          }
        }
        throw new Error(`Database not ready after ${attempts} attempts: ${errMessage(lastErr)}`);
      },
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
        await consoleExec(['cache:clear']);
      },
      checkHealth: async () =>
        evaluateHealth(
          opts.instanceId,
          await deps.probeHealth(routing.publicFrontendUrl, routing.browserApiPrefix),
          deps.now,
        ),
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
  const manifest = await new ManifestStore(instanceId, deps.root).read();
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
}

export async function instanceUpdate(deps: ActionDeps, instanceId: string, opts: InstanceUpdateOptions): Promise<{ plan: UpdatePlan; executed: boolean; report?: Awaited<ReturnType<typeof executeUpdate>> }> {
  const manifestStore = new ManifestStore(instanceId, deps.root);
  const manifest = await manifestStore.read();
  const channel = opts.channel ?? manifest.registry.channel;
  const client = registryClient(deps, manifest.registry.url);
  const index = await client.getIndex();

  const coreReleases: CoreRelease[] = [];
  for (const ref of index.core.filter((r) => r.channel === channel && !r.blocked)) {
    coreReleases.push((await client.getCoreRelease(ref)).release);
  }
  const frontendReleases = await fetchAllFrontends(client, index.frontend, channel);
  const pluginReleases: PluginRelease[] = [];

  const facts = await deps.resourceFacts([80, 443]);
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

  if (opts.dryRun || plan.status === 'blocked' || plan.status === 'up_to_date' || plan.core === null || plan.frontend === null) {
    return { plan, executed: false };
  }

  const paths = instancePaths(instanceId, deps.root);
  const core = plan.core;
  const frontend = plan.frontend;
  const services = await deps.resolveServiceDigests({
    mysql: manifest.images.mysql,
    redis: manifest.images.redis,
    mercure: manifest.images.mercure,
  });

  const report = await executeUpdate(
    { instanceId, targetVersion: plan.targetVersion!, preflightId: `cli-${Date.now()}`, approvedByUserId: 0, audit: { at: deps.now?.() ?? new Date().toISOString(), actorUserId: 0, requestedInstanceId: instanceId, trustedInstanceId: instanceId, allowed: true, reason: 'cli operator' } },
    plan,
    {
      runner: deps.runner,
      instanceDir: paths.dir,
      takeBackup: async () => ({ backupId: `backup-${Date.now()}-${instanceId}` }),
      applyArtifacts: async () => {
        const artifacts = buildInstanceInstallArtifacts({
          instanceId,
          displayName: manifest.displayName,
          mode: manifest.mode,
          ...(manifest.mode === 'production' ? { domain: manifest.domain } : {}),
          root: deps.root,
          managerVersion: deps.managerVersion,
          channel,
          registry: { id: manifest.registry.id, url: manifest.registry.url, metadataSha256: client.lastSuccessfulCheck?.metadataSha256 ?? '' },
          core,
          frontend,
          services,
          mercurePublicUrl: `${manifest.routing.publicFrontendUrl}/.well-known/mercure`,
          installedPlugins: manifest.installedPlugins,
        });
        await writeFileAtomic(paths.composePath, artifacts.composeYaml);
        await writeFileAtomic(paths.envPath, artifacts.envText);
        await writeFileAtomic(paths.readmePath, artifacts.readme);
        await manifestStore.write({ ...artifacts.manifest, createdAt: manifest.createdAt, updatedAt: deps.now?.() ?? new Date().toISOString() });
        await new LockStore(instanceId, deps.root).write(artifacts.lock);
      },
      runMigrations: async () => {
        await deps.runner.run(paths.dir, ['exec', '-T', 'backend', 'php', 'bin/console', 'doctrine:migrations:migrate', '--no-interaction', '--allow-no-migration']);
      },
      checkHealth: async () => evaluateHealth(instanceId, await deps.probeHealth(manifest.routing.publicFrontendUrl, manifest.routing.browserApiPrefix), deps.now),
      rollback: async () => {
        await deps.runner.run(paths.dir, composeCommands.upDetached());
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
  const manifest = await new ManifestStore(instanceId, deps.root).read();
  return processNextOperation({
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
  const manifest = await new ManifestStore(instanceId, deps.root).read();
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
  const dumpCmd =
    'exec mysqldump --no-tablespaces --single-transaction --routines --triggers ' +
    '-uroot -p"$MYSQL_ROOT_PASSWORD" --all-databases';
  const { stdout: dump } = await deps.runner.run(paths.dir, ['exec', '-T', 'mysql', 'sh', '-lc', dumpCmd]);
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
  if (deps.archiveVolume) {
    await deps.archiveVolume(`${project}_uploads`, path.join(backupDir, 'uploads.tgz'));
    includedAreas.push('uploads');
    await deps.archiveVolume(`${project}_plugin_artifacts`, path.join(backupDir, 'plugin_artifacts.tgz'));
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
  secretsRegenerated?: boolean;
  secretsWritten?: string[];
}> {
  const paths = instancePaths(instanceId, deps.root);
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

  // A restore-as-clone is a new security boundary: it MUST get fresh secrets and
  // never reuse the source's. A same-instance restore preserves the existing
  // on-disk secrets (the data they protect is unchanged) — so we leave them be.
  if (opts.apply && plan) {
    if (req.mode === 'restore_as_clone') {
      const { secrets } = secretsForRestore('restore_as_clone', undefined, secretGenOptions(deps));
      const secretsWritten = await writeInstanceSecrets(paths.secretsDir, secrets, deps.secretIO);
      return { validation, plan, backupDir, secretsRegenerated: true, secretsWritten };
    }
    return { validation, plan, backupDir, secretsRegenerated: false };
  }

  return { validation, plan, backupDir };
}

// ---------------------------------------------------------------------------
// instance clone (plan)
// ---------------------------------------------------------------------------

export interface CloneCliOptions {
  targetDomain: string;
  preserveVersions?: boolean;
  copyUploads?: boolean;
  copyPluginArtifacts?: boolean;
  /** When true, materialize the clone's fresh secrets on disk (else plan only). */
  apply?: boolean;
}

export async function instanceClone(
  deps: ActionDeps,
  sourceInstanceId: string,
  targetInstanceId: string,
  opts: CloneCliOptions,
): Promise<{ plan: ClonePlan; secretsWritten?: string[] }> {
  const sourceLock = await new LockStore(sourceInstanceId, deps.root).read();
  const sourceManifest = await new ManifestStore(sourceInstanceId, deps.root).read();
  const req: CloneRequest = {
    sourceInstanceId,
    targetInstanceId,
    targetDomain: opts.targetDomain,
    preserveVersionsFromLock: opts.preserveVersions ?? true,
    generateNewSecrets: true,
    copyUploads: opts.copyUploads ?? true,
    copyPluginArtifacts: opts.copyPluginArtifacts ?? true,
    sourceDomain: sourceManifest.domain,
  };
  const plan = planClone(req, sourceLock);

  // A clone is a distinct security boundary: always generate fresh secrets and
  // write them into the target's own secrets/ dir. The source secrets are never
  // read or copied here.
  if (opts.apply) {
    const targetPaths = instancePaths(targetInstanceId, deps.root);
    const secrets = generateCloneSecrets(secretGenOptions(deps));
    const secretsWritten = await writeInstanceSecrets(targetPaths.secretsDir, secrets, deps.secretIO);
    return { plan, secretsWritten };
  }

  return { plan };
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
  const manifest = await new ManifestStore(instanceId, deps.root).read();
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
// instance safe-mode (delegates to the backend console command)
// ---------------------------------------------------------------------------

export async function instanceSafeMode(deps: ActionDeps, instanceId: string, enable: boolean): Promise<void> {
  const paths = instancePaths(instanceId, deps.root);
  await deps.runner.run(paths.dir, [
    'exec',
    '-T',
    'backend',
    'php',
    'bin/console',
    'selfhelp:plugin:safe-mode',
    enable ? '--enable' : '--disable',
  ]);
}
