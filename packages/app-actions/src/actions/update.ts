// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance update actions: the core-driven update (dry-run + execute, with
 * backup/rollback/MySQL-major gating) and the lightweight frontend-only update.
 */
import { readFile } from 'node:fs/promises';
import semver from 'semver';
import { formatTrustedKeysEnv } from '@shm/schemas';
import type { CoreRelease, InstanceLock, InstanceManifest, PluginRelease, ReleaseChannel } from '@shm/schemas';
import { composeCommands } from '@shm/docker';
import {
  buildInstanceInstallArtifacts,
  evaluateHealth,
  evaluateMysqlMajorUpgrade,
  executeFrontendUpdate,
  executeUpdate,
  planFrontendUpdate,
  planUpdate,
  reinstallPluginsForCore,
  resolveTargetRuntimeImages,
  type FrontendUpdatePlan,
  type UpdatePlan,
  type UpdateStepResult,
} from '@shm/core';
import {
  LockStore,
  ManifestStore,
  ensureManagerToken,
  instancePaths,
  readInstanceSecrets,
  writeFileAtomic,
  writeInstanceSecrets,
} from '@shm/instances';
import {
  fetchAllFrontends,
  pluginSeams,
  readManifestFriendly,
  registryClient,
  releaseShapesFromLock,
  restorePluginStateAfterRecreate,
  type ActionDeps,
} from './shared.js';
import { instanceBackup } from './backup.js';

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
