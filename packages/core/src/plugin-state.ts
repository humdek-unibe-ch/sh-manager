// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Manager-side plugin operations for managed-mode instances.
 *
 * The backend's production plugin install mode is `managed`: the CMS admin UI
 * stages + verifies the plugin (signature against the trusted keys, extraction
 * to the shared `var/plugins` volume) and then PARKS the operation in
 * `running` state with a runbook — an external operator must run the composer
 * step and finalize. On manager-managed servers, the manager IS that
 * operator. This module is the pure orchestration for that role:
 *
 * - {@link finalizePluginOperations} — drain parked operations: composer
 *   require/remove in the backend, `selfhelp:plugin:run-operation` finalize
 *   (migrations, bundles file, lock), enable on install, then propagate the
 *   composer state to worker + scheduler and restart the Symfony services.
 * - {@link reinstallPluginsForCore} — after a core update recreated the
 *   containers from fresh images (vendor reset to the baked state), re-require
 *   every installed plugin against the new core and repair the plugin layer.
 * - {@link restorePluginStateIfNeeded} — after a container recreate WITHOUT a
 *   version change (address/mailer change, manual recreate), restore the
 *   composer state snapshot from the shared volume — no network needed.
 *
 * Durability model: vendor/ lives in each container's writable layer and is
 * lost on recreate, so after every successful drain the manager snapshots the
 * composer state (vendor, composer.json/lock, plugin lock file, generated
 * bundles file) as a tar on the shared `plugin_artifacts` volume, keyed by
 * core version. Worker/scheduler are synced from that snapshot rather than
 * running composer themselves: byte-identical state, no GitHub rate limits.
 *
 * Everything is injected ({@link PluginExecDeps}) so the ordering and failure
 * semantics are unit-testable without Docker.
 */

export type SymfonyService = 'backend' | 'worker' | 'scheduler';

/** Services that run the Symfony app and need the plugin composer state. */
export const SYMFONY_SERVICES: readonly SymfonyService[] = ['backend', 'worker', 'scheduler'];

/** Snapshot directory on the shared `plugin_artifacts` volume. */
export const PLUGIN_STATE_DIR = '/app/var/plugins/.shm-composer-state';

/**
 * Marker proving the container still carries the finalized plugin state.
 * Written by the backend's plugin finalize/repair; baked images do not have
 * it, so its absence after a recreate means the state must be restored.
 */
export const PLUGIN_STATE_MARKER = '/app/selfhelp.plugins.lock.json';

/** Paths bundled into the composer-state snapshot (relative to /app). */
const SNAPSHOT_PATHS = [
  'vendor',
  'composer.json',
  'composer.lock',
  'selfhelp.plugins.lock.json',
  'config/selfhelp_plugin_bundles.php',
];

export function pluginStateSnapshotPath(coreVersion: string): string {
  return `${PLUGIN_STATE_DIR}/composer-state-${coreVersion.replace(/[^a-zA-Z0-9._-]/g, '_')}.tar`;
}

/** A managed-mode plugin operation parked by the backend for the operator. */
export interface PendingPluginOperation {
  operationId: number;
  pluginId: string;
  type: 'install' | 'update' | 'uninstall';
  /** Composer package coordinates from the operation's resolved source. */
  package: string | null;
  version: string | null;
  repository: { type?: string; url?: string } | null;
  /**
   * For `.shplugin` archive installs: the signature-verified staging dir the
   * backend extracted (inside the backend container). The drain promotes its
   * runtime artifacts to the public web dir — the step the backend's worker
   * performs itself in non-managed modes.
   */
  archiveStagingDir?: string | null;
}

/** An installed plugin row (the durable record in the instance database). */
export interface InstalledPluginRecord {
  pluginId: string;
  version: string;
  enabled: boolean;
  package: string | null;
  repository: { type?: string; url?: string } | null;
}

export interface PluginExecDeps {
  /** Run a command inside one Symfony service (compose exec -T). */
  exec: (
    service: SymfonyService,
    cmd: string[],
    opts?: { user?: string; env?: Record<string, string> },
  ) => Promise<string>;
  /** Restart the given services (docker compose restart …). */
  restart: (services: readonly SymfonyService[]) => Promise<void>;
  log?: (line: string) => void | Promise<void>;
}

export interface PluginOperationOutcome {
  operationId: number;
  pluginId: string;
  type: PendingPluginOperation['type'];
  status: 'done' | 'failed';
  detail?: string;
}

export interface PluginDrainReport {
  outcomes: PluginOperationOutcome[];
  restarted: boolean;
}

const COMPOSER_ENV = { COMPOSER_HOME: '/tmp/composer', COMPOSER_NO_DEV: '1' };

async function logLine(deps: PluginExecDeps, line: string): Promise<void> {
  await deps.log?.(line);
}

/**
 * The core images ship without `git`, but composer needs it for vcs
 * repositories (the GitHub API zip path is unauthenticated and rate-limited,
 * so it cannot be relied on — see {@link repositoryConfigJson}). Install it
 * once per container lifetime; lost on recreate, re-ensured on the next drain.
 */
async function ensureGitInBackend(deps: PluginExecDeps): Promise<void> {
  await deps.exec(
    'backend',
    ['sh', '-c', 'command -v git >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq --no-install-recommends git) >/dev/null 2>&1'],
    { user: '0' },
  );
}

/**
 * Composer repository JSON for an operation. For https vcs URLs we force
 * `no-api: true` so composer uses the plain git driver (anonymous https
 * clone) instead of the GitHub API: unauthenticated API quota is 60/h per IP
 * and exhausting it makes composer fall back to `git@github.com:` SSH clones
 * that can never work here.
 */
function repositoryConfigJson(repository: { type?: string; url?: string }): string {
  const type = repository.type ?? 'vcs';
  const noApi = type === 'vcs' && /^https:\/\//i.test(repository.url ?? '');
  return JSON.stringify({ type, url: repository.url, ...(noApi ? { 'no-api': true } : {}) });
}

/**
 * The baked images leave /app root-owned while PHP runs as www-data, so the
 * finalize step's lock-file write (`rename()` into /app) would fail. Hand the
 * directory entry to the www-data group once per container; idempotent.
 */
async function prepareAppDir(deps: PluginExecDeps, service: SymfonyService): Promise<void> {
  await deps.exec(service, ['sh', '-c', 'chgrp www-data /app && chmod g+w /app'], { user: '0' });
}

async function composerRequire(deps: PluginExecDeps, op: PendingPluginOperation): Promise<void> {
  if (op.package === null || op.version === null) {
    throw new Error(`Operation #${op.operationId} (${op.pluginId}) has no composer coordinates.`);
  }
  if (op.repository?.url) {
    await deps.exec(
      'backend',
      ['composer', 'config', `repositories.shm-${op.pluginId}`, repositoryConfigJson(op.repository)],
      { env: COMPOSER_ENV },
    );
  }
  await logLine(deps, `composer require ${op.package}:${op.version} (backend)`);
  await deps.exec(
    'backend',
    ['composer', 'require', `${op.package}:${op.version}`, '--no-interaction', '--no-scripts', '--no-progress'],
    { env: COMPOSER_ENV },
  );
}

async function composerRemove(deps: PluginExecDeps, op: PendingPluginOperation): Promise<void> {
  if (op.package === null) return; // nothing composer-managed to remove
  await logLine(deps, `composer remove ${op.package} (backend)`);
  try {
    await deps.exec(
      'backend',
      ['composer', 'remove', op.package, '--no-interaction', '--no-scripts', '--no-progress'],
      { env: COMPOSER_ENV },
    );
  } catch (err) {
    // Already absent (e.g. retried uninstall) — the finalize step is the
    // authoritative cleanup; a missing package must not block it.
    await logLine(deps, `composer remove ${op.package} failed (continuing): ${errMessage(err)}`);
  }
}

/**
 * Promote the runtime artifacts of a signature-verified `.shplugin` staging
 * dir (extracted by the backend before parking the operation) into
 * `var/plugins/<id>-<ver>/installed/` and `public/plugin-artifacts/<id>-<ver>/`
 * — the same locations the backend's own `PluginArchivePromoter` uses in
 * non-managed modes. Without this the plugin row exists but the host frontend
 * cannot `import()` the plugin bundle ("plugin runtime import failed").
 * Copy-into-temp + rename so a failure never leaves a half-written dir.
 */
async function promoteStagedArtifacts(deps: PluginExecDeps, op: PendingPluginOperation): Promise<void> {
  if (!op.archiveStagingDir || op.version === null) return;
  const idVer = `${op.pluginId}-${op.version}`;
  await logLine(deps, `promote staged runtime artifacts -> /app/public/plugin-artifacts/${idVer}`);
  const staging = op.archiveStagingDir;
  const installed = `/app/var/plugins/${idVer}/installed`;
  const publicDir = `/app/public/plugin-artifacts/${idVer}`;
  const script = [
    'set -e',
    `[ -d "${staging}/artifacts" ] || { echo "no staged artifacts dir"; exit 0; }`,
    `rm -rf "${installed}.tmp"; mkdir -p "${installed}.tmp"; cp -a "${staging}/." "${installed}.tmp/"`,
    `rm -rf "${installed}"; mv "${installed}.tmp" "${installed}"`,
    `rm -rf "${publicDir}.tmp"; mkdir -p "${publicDir}.tmp"; cp -a "${staging}/artifacts/." "${publicDir}.tmp/"`,
    `rm -rf "${publicDir}"; mv "${publicDir}.tmp" "${publicDir}"`,
  ].join('\n');
  await deps.exec('backend', ['sh', '-c', script]);
}

/**
 * Finalize one parked operation via the backend's own CLI. A duplicate-entry
 * failure means an earlier finalize attempt died halfway (plugin row written,
 * lock/bundles not) — `selfhelp:plugin:repair` reconciles those artifacts from
 * the database, which is exactly the documented recovery.
 */
async function finalizeOperation(deps: PluginExecDeps, op: PendingPluginOperation): Promise<void> {
  await logLine(deps, `finalize plugin operation #${op.operationId} (${op.type} ${op.pluginId})`);
  try {
    await deps.exec('backend', ['php', 'bin/console', 'selfhelp:plugin:run-operation', String(op.operationId)]);
  } catch (err) {
    const message = errMessage(err);
    if (/Duplicate entry/i.test(message)) {
      await logLine(deps, `operation #${op.operationId} partially finalized earlier — running selfhelp:plugin:repair`);
      await deps.exec('backend', ['php', 'bin/console', 'selfhelp:plugin:repair']);
      return;
    }
    throw err;
  }
}

/** Snapshot the backend's composer state to the shared volume (per core version). */
async function snapshotPluginState(deps: PluginExecDeps, coreVersion: string): Promise<void> {
  const tarPath = pluginStateSnapshotPath(coreVersion);
  await logLine(deps, `snapshot composer state -> ${tarPath}`);
  await deps.exec('backend', [
    'sh',
    '-c',
    `mkdir -p ${PLUGIN_STATE_DIR} && rm -f ${PLUGIN_STATE_DIR}/*.tar && ` +
      `tar -cf ${tarPath} -C /app --ignore-failed-read ${SNAPSHOT_PATHS.join(' ')}`,
  ]);
}

/** Extract the snapshot into one service's /app (worker/scheduler sync, restores). */
async function extractSnapshot(deps: PluginExecDeps, service: SymfonyService, coreVersion: string): Promise<void> {
  await prepareAppDir(deps, service);
  await deps.exec(service, ['sh', '-c', `tar -xf ${pluginStateSnapshotPath(coreVersion)} -C /app`]);
}

/**
 * Drain parked managed-mode plugin operations. Sequential and fail-fast: a
 * failed operation stops the drain (state is uncertain), but the snapshot +
 * sync + restart still run when any operation finalized so the services pick
 * up everything that DID complete. Returns per-operation outcomes.
 */
export async function finalizePluginOperations(
  input: { operations: PendingPluginOperation[]; coreVersion: string },
  deps: PluginExecDeps,
): Promise<PluginDrainReport> {
  const outcomes: PluginOperationOutcome[] = [];
  if (input.operations.length === 0) return { outcomes, restarted: false };

  for (const service of SYMFONY_SERVICES) await prepareAppDir(deps, service);
  await ensureGitInBackend(deps);

  // A recreate may have reset the backend's vendor since the LAST drain; pull
  // the previous state back first so this drain builds on top of every plugin
  // already installed instead of silently dropping them from the new snapshot.
  await restoreIntoBackendIfMarkerMissing(deps, input.coreVersion);

  for (const op of input.operations) {
    try {
      if (op.type === 'uninstall') {
        await composerRemove(deps, op);
      } else {
        await composerRequire(deps, op);
        await promoteStagedArtifacts(deps, op);
      }
      await finalizeOperation(deps, op);
      if (op.type === 'install') {
        await deps.exec('backend', ['php', 'bin/console', 'selfhelp:plugin:enable', op.pluginId]);
      }
      outcomes.push({ operationId: op.operationId, pluginId: op.pluginId, type: op.type, status: 'done' });
    } catch (err) {
      outcomes.push({
        operationId: op.operationId,
        pluginId: op.pluginId,
        type: op.type,
        status: 'failed',
        detail: errMessage(err),
      });
      await logLine(deps, `plugin operation #${op.operationId} failed: ${errMessage(err)}`);
      // Move the row out of `running` so the CMS shows the failure and the
      // poller does not retry (and re-fail) the same operation every tick —
      // the operator retries deliberately from the plugins page.
      try {
        await deps.exec('backend', ['php', 'bin/console', 'selfhelp:plugin:cancel-operation', String(op.operationId)]);
      } catch (cancelErr) {
        await logLine(deps, `could not cancel operation #${op.operationId}: ${errMessage(cancelErr)}`);
      }
      break;
    }
  }

  const anyDone = outcomes.some((o) => o.status === 'done');
  if (anyDone) {
    await snapshotPluginState(deps, input.coreVersion);
    await extractSnapshot(deps, 'worker', input.coreVersion);
    await extractSnapshot(deps, 'scheduler', input.coreVersion);
    await deps.restart(SYMFONY_SERVICES);
  }
  return { outcomes, restarted: anyDone };
}

/**
 * Durable copy of a standalone-archive plugin's backend package. The drain's
 * artifact promotion mirrors the signature-verified staging tree into
 * `installed/` on the shared plugin volume, so this directory survives
 * container recreates and core updates. Used as a composer path repo when
 * the plugin's manifest names no upstream repository (archive installs).
 */
function archivePathRepoDir(pluginId: string, version: string): string {
  return `/app/var/plugins/${pluginId}-${version}/installed/backend/package`;
}

/**
 * Post-core-update plugin reinstall. The update recreated every container
 * from fresh images, so the previous composer state (vendor) is gone while
 * the database still records the installed plugins. Re-require each plugin
 * against the NEW core (the previous snapshot is for the old core and must
 * not be reused), repair the plugin layer, snapshot, sync, restart.
 */
export async function reinstallPluginsForCore(
  input: { plugins: InstalledPluginRecord[]; coreVersion: string },
  deps: PluginExecDeps,
): Promise<{ reinstalled: string[]; restarted: boolean }> {
  const withComposer = input.plugins.filter((p) => p.package !== null);
  if (withComposer.length === 0) return { reinstalled: [], restarted: false };

  for (const service of SYMFONY_SERVICES) await prepareAppDir(deps, service);
  await ensureGitInBackend(deps);

  const reinstalled: string[] = [];
  for (const plugin of withComposer) {
    let repository = plugin.repository;
    if (!repository?.url) {
      // Standalone-archive plugins have no upstream repo in their manifest;
      // re-require from the verified package copy promoted to the plugin
      // volume at install time (same fallback the drain uses for parked ops).
      const archiveDir = archivePathRepoDir(plugin.pluginId, plugin.version);
      if (await dirExists(deps, 'backend', archiveDir)) {
        repository = { type: 'path', url: archiveDir };
        await logLine(deps, `plugin ${plugin.pluginId} has no upstream repository — using the promoted archive at ${archiveDir}`);
      }
    }
    if (repository?.url) {
      await deps.exec(
        'backend',
        ['composer', 'config', `repositories.shm-${plugin.pluginId}`, repositoryConfigJson(repository)],
        { env: COMPOSER_ENV },
      );
    }
    await logLine(deps, `reinstall plugin ${plugin.pluginId} ${plugin.version} for core ${input.coreVersion}`);
    await deps.exec(
      'backend',
      ['composer', 'require', `${plugin.package}:${plugin.version}`, '--no-interaction', '--no-scripts', '--no-progress'],
      { env: COMPOSER_ENV },
    );
    reinstalled.push(plugin.pluginId);
  }

  // Regenerate the bundles file + plugin lock from the database (covers
  // enabled state), then propagate + restart so the new kernel loads them.
  await deps.exec('backend', ['php', 'bin/console', 'selfhelp:plugin:repair']);
  await snapshotPluginState(deps, input.coreVersion);
  await extractSnapshot(deps, 'worker', input.coreVersion);
  await extractSnapshot(deps, 'scheduler', input.coreVersion);
  await deps.restart(SYMFONY_SERVICES);
  return { reinstalled, restarted: true };
}

/**
 * Restore the composer-state snapshot after a same-version container recreate
 * (address/mailer change, manual recreate). No-op when the marker file is
 * still present (no recreate happened) or no snapshot exists (no plugins were
 * ever installed). Network-free.
 */
export async function restorePluginStateIfNeeded(
  deps: PluginExecDeps,
  coreVersion: string,
): Promise<{ restored: boolean }> {
  const markerPresent = await fileExists(deps, 'backend', PLUGIN_STATE_MARKER);
  if (markerPresent) return { restored: false };
  const snapshotPresent = await fileExists(deps, 'backend', pluginStateSnapshotPath(coreVersion));
  if (!snapshotPresent) return { restored: false };

  await logLine(deps, `plugin state missing after recreate — restoring snapshot for core ${coreVersion}`);
  for (const service of SYMFONY_SERVICES) {
    await extractSnapshot(deps, service, coreVersion);
  }
  await deps.restart(SYMFONY_SERVICES);
  return { restored: true };
}

/** Backend-only variant used at the start of a drain (no restart — the drain restarts at the end). */
async function restoreIntoBackendIfMarkerMissing(deps: PluginExecDeps, coreVersion: string): Promise<void> {
  const markerPresent = await fileExists(deps, 'backend', PLUGIN_STATE_MARKER);
  if (markerPresent) return;
  const snapshotPresent = await fileExists(deps, 'backend', pluginStateSnapshotPath(coreVersion));
  if (!snapshotPresent) return;
  await logLine(deps, 'backend lost its plugin state to a recreate — restoring snapshot before draining');
  await extractSnapshot(deps, 'backend', coreVersion);
}

async function fileExists(deps: PluginExecDeps, service: SymfonyService, path: string): Promise<boolean> {
  const out = await deps.exec(service, ['sh', '-c', `test -f ${path} && echo yes || echo no`]);
  return out.trim().endsWith('yes');
}

async function dirExists(deps: PluginExecDeps, service: SymfonyService, path: string): Promise<boolean> {
  const out = await deps.exec(service, ['sh', '-c', `test -d ${path} && echo yes || echo no`]);
  return out.trim().endsWith('yes');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
