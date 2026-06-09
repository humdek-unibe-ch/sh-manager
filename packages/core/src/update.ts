// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Update dry-run planning + execution.
 *
 * `planUpdate` resolves a target, evaluates plugin compatibility + advisories,
 * and produces a preflight. `executeUpdate` performs the ordered, safe update:
 * backup first, pull signed artifacts, bring services up, migrate, health-check,
 * and roll back on failure. Volumes (DB/uploads/plugins) always survive.
 */
import type {
  CoreRelease,
  FrontendRelease,
  PluginRelease,
  PreflightOption,
  ReleaseChannel,
  RuntimeServicePolicy,
  SecurityAdvisory,
  UpdatePreflightResult,
} from '@shm/schemas';
import {
  evaluatePluginAgainstTargetCore,
  pickFrontendForCore,
  resolveCoreTarget,
  type PluginUpdateBlock,
} from '@shm/resolver';
import { composeCommands, type ComposeRunner } from '@shm/docker';
import { runPreflight, type PreflightResourceFacts, type PreflightThresholds } from './preflight.js';
import { isHealthy, type HealthReport } from './health.js';
import type { ApprovedUpdate } from './instance-scope.js';

export type UpdateStatus = 'ok' | 'warning' | 'blocked' | 'up_to_date';

export interface UpdatePlanInput {
  instanceId: string;
  currentVersion: string;
  channel?: ReleaseChannel;
  target?: 'latest' | string;
  coreReleases: CoreRelease[];
  frontendReleases: FrontendRelease[];
  pluginReleases: PluginRelease[];
  installedPlugins: { id: string; version: string }[];
  advisories?: SecurityAdvisory[];
  resources: PreflightResourceFacts;
  thresholds?: Partial<PreflightThresholds>;
  driftBlocks?: string[];
}

export interface PluginEvaluation extends PluginUpdateBlock {
  pluginId: string;
  installedVersion: string;
}

export interface UpdatePlan {
  instanceId: string;
  currentVersion: string;
  targetVersion: string | null;
  status: UpdateStatus;
  core: CoreRelease | null;
  frontend: FrontendRelease | null;
  reasons: string[];
  pluginEvaluations: PluginEvaluation[];
  preflight: UpdatePreflightResult | null;
  steps: string[];
}

export function planUpdate(input: UpdatePlanInput): UpdatePlan {
  const advisories = input.advisories ?? [];
  const coreResult = resolveCoreTarget({
    currentVersion: input.currentVersion,
    available: input.coreReleases,
    target: input.target ?? 'latest',
    channel: input.channel ?? 'stable',
    advisories,
  });

  if (coreResult.status === 'up_to_date') {
    return blankPlan(input, 'up_to_date', null, coreResult.reasons);
  }
  if (coreResult.status === 'blocked' || coreResult.selected === null) {
    return blankPlan(input, 'blocked', null, coreResult.reasons);
  }

  const core = coreResult.selected;
  const frontend = pickFrontendForCore(core, input.frontendReleases);
  const reasons = [...coreResult.reasons];

  const pluginEvaluations: PluginEvaluation[] = input.installedPlugins.map((p) => {
    const eval_ = evaluatePluginAgainstTargetCore(
      p,
      core.version,
      core.pluginApiVersion,
      input.pluginReleases.filter((r) => r.id === p.id),
      advisories,
    );
    return { ...eval_, pluginId: p.id, installedVersion: p.version };
  });

  const compatibilityBlocks: string[] = [];
  const pluginOptions: PreflightOption[] = [];
  if (frontend === null) {
    compatibilityBlocks.push(`No compatible frontend release found for SelfHelp ${core.version}.`);
  }
  for (const ev of pluginEvaluations) {
    if (ev.blocked) {
      compatibilityBlocks.push(ev.message);
      for (const o of ev.options) pluginOptions.push({ type: o.type, version: o.value, label: o.label });
    }
  }

  const preflight = runPreflight({
    instanceId: input.instanceId,
    currentVersion: input.currentVersion,
    targetVersion: core.version,
    resources: input.resources,
    database: core.database,
    thresholds: input.thresholds,
    canDirectUpgrade: true,
    compatibilityBlocks,
    driftBlocks: input.driftBlocks,
    options: pluginOptions,
  });

  const status: UpdateStatus = preflight.status === 'ok' ? 'ok' : preflight.status === 'warning' ? 'warning' : 'blocked';

  return {
    instanceId: input.instanceId,
    currentVersion: input.currentVersion,
    targetVersion: core.version,
    status,
    core,
    frontend,
    reasons,
    pluginEvaluations,
    preflight,
    steps: buildSteps(core, frontend),
  };
}

function blankPlan(input: UpdatePlanInput, status: UpdateStatus, target: string | null, reasons: string[]): UpdatePlan {
  return {
    instanceId: input.instanceId,
    currentVersion: input.currentVersion,
    targetVersion: target,
    status,
    core: null,
    frontend: null,
    reasons,
    pluginEvaluations: [],
    preflight: null,
    steps: [],
  };
}

function buildSteps(core: CoreRelease, frontend: FrontendRelease | null): string[] {
  return [
    'verify signatures + checksums of target artifacts',
    core.database.requiresBackup ? 'take a full backup (database + uploads + plugin artifacts)' : 'take a safety backup',
    `pull backend/worker/scheduler images (${core.version})`,
    frontend ? `pull frontend image (${frontend.version})` : 'resolve compatible frontend image',
    'write new manifest + lock + .env + compose',
    'recreate containers (docker compose up -d)',
    core.database.destructive ? 'run migrations (destructive: confirmed)' : 'run migrations if required',
    'run health checks',
    'on failure: automatic rollback to the pre-update backup (volumes preserved)',
  ];
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface UpdateRollbackContext {
  backupId: string;
  reason: string;
  /** True when database migrations were attempted before the failure. */
  migrated: boolean;
  /** True when the target's migrations were flagged destructive. */
  destructive: boolean;
}

/**
 * Traffic-producing services taken offline during the maintenance window. The
 * backend + mysql stay up so the instance can serve a clean 503 (and the Manager
 * loop, health probe, auth, and admin.system routes stay reachable) while the
 * stack is replaced and migrated.
 */
export const MAINTENANCE_STOP_SERVICES = ['frontend', 'worker', 'scheduler'] as const;

export interface UpdateExecutionDeps {
  runner: ComposeRunner;
  instanceDir: string;
  takeBackup: () => Promise<{ backupId: string }>;
  /**
   * Capture the pre-update instance state (compose.yaml, manifest, lock, image
   * digests, migration head). Called AFTER the backup and BEFORE any mutation
   * so a failure can be rolled back to exactly the prior config. A failure here
   * aborts the update before anything is mutated.
   */
  snapshot: () => Promise<void>;
  applyArtifacts: () => Promise<void>;
  runMigrations: () => Promise<void>;
  checkHealth: () => Promise<HealthReport>;
  /**
   * Restore the snapshot captured by {@link snapshot} (previous config +
   * containers). Data is only truly rolled back when `migrated` is false; once
   * destructive migrations have run the caller must restore from the backup.
   */
  rollback: (ctx: UpdateRollbackContext) => Promise<void>;
  /**
   * Turn the backend's maintenance gate on (clean 503 for normal traffic). Called
   * once before stopping the traffic producers and re-asserted after the stack is
   * recreated (the lock lives in the backend container's ephemeral filesystem, so
   * it must be re-set on the fresh container to cover the migrate + health window).
   * Optional: omitted in unit tests that do not exercise the maintenance window.
   */
  enterMaintenance?: () => Promise<void>;
  /** Turn the maintenance gate off. Only called on the success path after health passes (and best-effort during rollback so the instance never stays stuck in maintenance). */
  exitMaintenance?: () => Promise<void>;
  /** Stop the given services (`docker compose stop <names>`) without removing them or any volume. */
  stopServices?: (names: readonly string[]) => Promise<void>;
  now?: () => string;
}

export type StepStatus = 'done' | 'failed' | 'skipped';
export interface UpdateStepResult {
  name: string;
  status: StepStatus;
  detail?: string;
}

export interface UpdateExecutionReport {
  instanceId: string;
  targetVersion: string;
  ok: boolean;
  rolledBack: boolean;
  /**
   * Set when rollback only restored configuration but data must still be
   * recovered from the backup (failure after destructive migrations ran).
   */
  requiresManualRestore?: boolean;
  backupId?: string;
  steps: UpdateStepResult[];
}

/** Executes an approved, non-blocked update plan with rollback-on-failure. */
export async function executeUpdate(
  approved: ApprovedUpdate,
  plan: UpdatePlan,
  deps: UpdateExecutionDeps,
): Promise<UpdateExecutionReport> {
  if (plan.status === 'blocked' || plan.targetVersion === null) {
    throw new Error('Refusing to execute a blocked update plan.');
  }
  if (plan.targetVersion !== approved.targetVersion) {
    throw new Error('Approved target version does not match the resolved plan.');
  }

  const steps: UpdateStepResult[] = [];
  const report: UpdateExecutionReport = {
    instanceId: approved.instanceId,
    targetVersion: approved.targetVersion,
    ok: false,
    rolledBack: false,
    steps,
  };

  // Backup first — before any mutation. A failure here aborts without rollback.
  let backupId: string;
  try {
    const b = await deps.takeBackup();
    backupId = b.backupId;
    report.backupId = backupId;
    steps.push({ name: 'backup', status: 'done', detail: backupId });
  } catch (err) {
    steps.push({ name: 'backup', status: 'failed', detail: errMessage(err) });
    return report;
  }

  // Snapshot the pre-update state next, still before any mutation. If we cannot
  // capture the snapshot we cannot guarantee a config rollback, so abort now.
  try {
    await deps.snapshot();
    steps.push({ name: 'snapshot', status: 'done' });
  } catch (err) {
    steps.push({ name: 'snapshot', status: 'failed', detail: errMessage(err) });
    return report;
  }

  // Enter maintenance and take the traffic producers offline BEFORE any
  // mutation. Nothing is mutated yet, so a failure here aborts cleanly (with a
  // best-effort exit so the instance is never left stuck in maintenance).
  try {
    if (deps.enterMaintenance) {
      await deps.enterMaintenance();
      steps.push({ name: 'maintenance-enter', status: 'done' });
    }
    if (deps.stopServices) {
      await deps.stopServices(MAINTENANCE_STOP_SERVICES);
      steps.push({ name: 'stop-services', status: 'done', detail: MAINTENANCE_STOP_SERVICES.join(',') });
    }
  } catch (err) {
    steps.push({ name: 'maintenance-enter', status: 'failed', detail: errMessage(err) });
    await safeExitMaintenance(deps);
    return report;
  }

  const destructive = plan.preflight?.database.destructive ?? false;
  let migrationsAttempted = false;

  try {
    await deps.runner.run(deps.instanceDir, composeCommands.pull());
    steps.push({ name: 'pull', status: 'done' });

    await deps.applyArtifacts();
    steps.push({ name: 'apply-artifacts', status: 'done' });

    await deps.runner.run(deps.instanceDir, composeCommands.upDetached());
    steps.push({ name: 'up', status: 'done' });

    // `up` recreated the backend (new image) AND restarted the frontend, so the
    // maintenance lock (ephemeral container fs) is gone. Re-assert it on the
    // fresh backend so the migrate + health window is still gated.
    if (deps.enterMaintenance) {
      await deps.enterMaintenance();
      steps.push({ name: 'maintenance-reassert', status: 'done' });
    }

    migrationsAttempted = true;
    await deps.runMigrations();
    steps.push({ name: 'migrate', status: 'done' });

    const health = await deps.checkHealth();
    if (!isHealthy(health)) {
      steps.push({ name: 'health', status: 'failed', detail: `overall=${health.overall}` });
      await runRollback(deps, steps, report, {
        backupId,
        reason: `health ${health.overall}`,
        migrated: migrationsAttempted,
        destructive,
      });
      return report;
    }
    steps.push({ name: 'health', status: 'done', detail: 'healthy' });

    // Leave maintenance only after health passes.
    if (deps.exitMaintenance) {
      await deps.exitMaintenance();
      steps.push({ name: 'maintenance-exit', status: 'done' });
    }

    report.ok = true;
    return report;
  } catch (err) {
    steps.push({ name: 'update', status: 'failed', detail: errMessage(err) });
    await runRollback(deps, steps, report, {
      backupId,
      reason: errMessage(err),
      migrated: migrationsAttempted,
      destructive,
    });
    return report;
  }
}

/**
 * Restores the pre-update snapshot and records the outcome. When the failure
 * happened after destructive migrations ran, configuration is restored but the
 * data must still be recovered from the backup, so we flag `requiresManualRestore`
 * instead of pretending the data was rolled back.
 */
async function runRollback(
  deps: UpdateExecutionDeps,
  steps: UpdateStepResult[],
  report: UpdateExecutionReport,
  ctx: UpdateRollbackContext,
): Promise<void> {
  try {
    await deps.rollback(ctx);
    report.rolledBack = true;
    if (ctx.migrated && ctx.destructive) {
      report.requiresManualRestore = true;
      steps.push({
        name: 'rollback',
        status: 'done',
        detail: `config restored; destructive migrations ran - restore backup ${ctx.backupId} to recover data`,
      });
    } else {
      steps.push({ name: 'rollback', status: 'done', detail: ctx.backupId });
    }
  } catch (rollbackErr) {
    steps.push({ name: 'rollback', status: 'failed', detail: errMessage(rollbackErr) });
  } finally {
    // The restored stack may reuse the same backend container (unchanged image),
    // which could still hold the maintenance lock. Always clear it so a failed
    // update never leaves the instance stuck in maintenance.
    await safeExitMaintenance(deps);
  }
}

/** Best-effort maintenance exit used on the abort/rollback paths. Never throws. */
async function safeExitMaintenance(deps: UpdateExecutionDeps): Promise<void> {
  if (!deps.exitMaintenance) return;
  try {
    await deps.exitMaintenance();
  } catch {
    // best-effort: the rollback already restored config + containers
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Runtime service (mysql/redis/mercure) image resolution + MySQL major gate
// ---------------------------------------------------------------------------

export interface RuntimeServiceImages {
  mysql: string;
  redis: string;
  mercure: string;
}

/**
 * Resolve the target runtime-service images for an update. Prefer the target
 * core's `runtime` recommended images (so a release can move MySQL/Redis/Mercure
 * forward), and fall back to the instance's CURRENT images when the target core
 * declares no runtime policy (never silently reset to manager defaults).
 */
export function resolveTargetRuntimeImages(
  runtime: RuntimeServicePolicy | undefined,
  current: RuntimeServiceImages,
): RuntimeServiceImages {
  return {
    mysql: runtime?.mysql.recommendedImage ?? current.mysql,
    redis: runtime?.redis.recommendedImage ?? current.redis,
    mercure: runtime?.mercure.recommendedImage ?? current.mercure,
  };
}

/**
 * Best-effort major-version parse from a docker image reference such as
 * `mysql:8.4`, `mysql:8.4.1`, or `mysql:8.4@sha256:...`. Returns null when the
 * tag is missing or not numeric (e.g. a bare digest pin).
 */
export function imageMajor(image: string): number | null {
  const beforeDigest = image.split('@', 1)[0] ?? image;
  const colon = beforeDigest.lastIndexOf(':');
  if (colon < 0) return null;
  const tag = beforeDigest.slice(colon + 1);
  const major = Number.parseInt(tag.split('.', 1)[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

export interface MysqlMajorUpgradeDecision {
  isMajorUpgrade: boolean;
  requiresApproval: boolean;
  fromMajor: number | null;
  toMajor: number | null;
}

/**
 * Decide whether a MySQL image change is a major-version upgrade and whether the
 * target core's policy demands explicit operator approval. The data volume is
 * always preserved, but a major MySQL jump is effectively one-way, so a release
 * can require a deliberate opt-in (plus a verified backup).
 */
export function evaluateMysqlMajorUpgrade(
  runtime: RuntimeServicePolicy | undefined,
  currentMysqlImage: string,
  targetMysqlImage: string,
): MysqlMajorUpgradeDecision {
  const fromMajor = imageMajor(currentMysqlImage);
  const toMajor = imageMajor(targetMysqlImage);
  const isMajorUpgrade = fromMajor !== null && toMajor !== null && toMajor > fromMajor;
  const requiresApproval = isMajorUpgrade && (runtime?.mysql.majorUpgradeRequiresManualApproval ?? false);
  return { isMajorUpgrade, requiresApproval, fromMajor, toMajor };
}
