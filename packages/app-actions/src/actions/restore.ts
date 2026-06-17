// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance restore + clone actions. Restore validates a backup then optionally
 * applies it (never destructive to volumes); clone copies a source instance
 * read-only into a fresh, credential-isolated target.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatTrustedKeysEnv } from '@shm/schemas';
import type { BackupManifest, InstanceLock, InstanceManifest } from '@shm/schemas';
import {
  buildInstanceRouting,
  composeCommands,
  composeProjectName,
  generateInstanceComposeYaml,
  toEnginePath,
} from '@shm/docker';
import { buildInstanceInstallArtifacts, evaluateHealth, installInstance, type HealthReport } from '@shm/core';
import {
  InventoryStore,
  LockStore,
  ManifestStore,
  generateCloneSecrets,
  instancePaths,
  secretsForRestore,
  writeFileAtomic,
  writeInstanceSecrets,
} from '@shm/instances';
import {
  REQUIRED_BACKUP_AREAS,
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
import {
  APP_DB_DUMP_CMD,
  copyAdminPasswordToClone,
  importDatabaseWithRetry,
  pathExists,
  readManifestFriendly,
  releaseShapesFromLock,
  restorePluginStateAfterRecreate,
  secretGenOptions,
  sha256Hex,
  waitForMysqlReady,
  type ActionDeps,
  type OperationProgress,
} from './shared.js';

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
