// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance install + read actions: install (optionally bring up + provision),
 * list, health, and the host resource preflight (`doctor`).
 */
import { readdir } from 'node:fs/promises';
import semver from 'semver';
import { formatTrustedKeysEnv } from '@shm/schemas';
import type { CoreRelease, FrontendRelease, InstanceMode, ReleaseChannel } from '@shm/schemas';
import { DEFAULT_PROXY_NETWORK, composeProjectName } from '@shm/docker';
import {
  buildInstanceInstallArtifacts,
  evaluateHealth,
  installInstance,
  provisionInstance,
  runPreflight,
  type HealthReport,
  type ProvisionReport,
  type ProvisionStepName,
} from '@shm/core';
import { InventoryStore, ManifestStore, instancePaths, instancesDir } from '@shm/instances';
import {
  DB_CREDENTIAL_FAILURE_LIMIT,
  DEFAULT_SERVICE_IMAGES,
  assertInstallableDomain,
  dbCredentialMismatchError,
  ensureProxyRunning,
  errMessage,
  fetchAllFrontends,
  isDbCredentialError,
  looksLikeInstanceState,
  persistOrReuseAdminPassword,
  readManifestFriendly,
  realSleep,
  reclaimStaleInstanceVolumes,
  registryClient,
  type ActionDeps,
} from './shared.js';

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
  /**
   * Free-text progress log (distinct from {@link onStep}, which drives the step
   * checklist). Used for one-off notices such as reclaiming a stale Docker
   * volume from a previous install; the GUI mirrors it into the operation log.
   */
  log?: (line: string) => void | Promise<void>;
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
  // Fresh install over a name whose previous instance was removed but whose
  // Docker volumes lingered: drop those stale volumes so MySQL re-initialises
  // with the new credentials (otherwise it rejects them — the "remove then
  // reinstall the same id fails with Access denied" report). No-op on a
  // retry/resume (on-disk secrets present) — those volumes still match.
  if (bringUp) await reclaimStaleInstanceVolumes(deps, opts.instanceId, opts.log);
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
