// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance backup actions: consistent checksummed backups, on-disk backup
 * listing, schedule get/set, GFS prune, and the one-shot scheduled-backup run
 * (shared by the web scheduler loop and cron/systemd).
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BackupManifest, BackupOrigin, BackupSchedulePolicy } from '@shm/schemas';
import { composeProjectName } from '@shm/docker';
import { InventoryStore, LockStore, ManifestStore, instancePaths, writeFileAtomic } from '@shm/instances';
import {
  DEFAULT_BACKUP_RETENTION,
  buildBackupManifest,
  estimateFootprint,
  isBackupDue,
  makeBackupId,
  nextBackupSeq,
  nextRunAt,
  planPrune,
  validateSchedulePolicy,
  type BackupCandidate,
  type FootprintEstimate,
  type PrunePlan,
} from '@shm/backup';
import { redactEnv } from '@shm/support';
import {
  APP_DB_DUMP_CMD,
  hashFilesIn,
  parseEnv,
  readManifestFriendly,
  type ActionDeps,
  type OperationProgress,
} from './shared.js';

// ---------------------------------------------------------------------------
// instance backup
// ---------------------------------------------------------------------------

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
