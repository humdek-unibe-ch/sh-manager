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
  resolveFrontendUpdate,
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
  /**
   * MySQL major-upgrade decision for this plan. `planUpdate` itself does not
   * know the instance's current runtime images, so this is attached by the
   * CLI's `instanceUpdate` (dry runs included) whenever a target core was
   * selected — the GUI update dialog uses it to demand explicit approval
   * before executing a one-way MySQL major upgrade.
   */
  mysqlMajor?: MysqlMajorUpgradeDecision;
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
  /**
   * Reinstall the instance's plugins against the NEW core after the containers
   * were recreated from fresh images (vendor resets to the baked state while
   * the database still records the installed plugins). Runs after migrations
   * and before the health check; a failure triggers the normal rollback.
   * Optional: instances without plugin support skip it.
   */
  restorePlugins?: () => Promise<void>;
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
  /**
   * Live progress hook, called the moment each step is recorded (not at the end)
   * so the manager journal can advance its phase + stream the log in real time.
   * It must never break the update: a throwing hook is swallowed.
   */
  onStep?: (step: UpdateStepResult) => void | Promise<void>;
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
    await emitStep(steps, deps.onStep, { name: 'backup', status: 'done', detail: backupId });
  } catch (err) {
    await emitStep(steps, deps.onStep, { name: 'backup', status: 'failed', detail: errMessage(err) });
    return report;
  }

  // Snapshot the pre-update state next, still before any mutation. If we cannot
  // capture the snapshot we cannot guarantee a config rollback, so abort now.
  try {
    await deps.snapshot();
    await emitStep(steps, deps.onStep, { name: 'snapshot', status: 'done' });
  } catch (err) {
    await emitStep(steps, deps.onStep, { name: 'snapshot', status: 'failed', detail: errMessage(err) });
    return report;
  }

  // Enter maintenance and take the traffic producers offline BEFORE any
  // mutation. Nothing is mutated yet, so a failure here aborts cleanly (with a
  // best-effort exit so the instance is never left stuck in maintenance).
  try {
    if (deps.enterMaintenance) {
      await deps.enterMaintenance();
      await emitStep(steps, deps.onStep, { name: 'maintenance-enter', status: 'done' });
    }
    if (deps.stopServices) {
      await deps.stopServices(MAINTENANCE_STOP_SERVICES);
      await emitStep(steps, deps.onStep, { name: 'stop-services', status: 'done', detail: MAINTENANCE_STOP_SERVICES.join(',') });
    }
  } catch (err) {
    await emitStep(steps, deps.onStep, { name: 'maintenance-enter', status: 'failed', detail: errMessage(err) });
    await safeExitMaintenance(deps);
    return report;
  }

  const destructive = plan.preflight?.database.destructive ?? false;
  let migrationsAttempted = false;

  try {
    await deps.runner.run(deps.instanceDir, composeCommands.pull());
    await emitStep(steps, deps.onStep, { name: 'pull', status: 'done' });

    await deps.applyArtifacts();
    await emitStep(steps, deps.onStep, { name: 'apply-artifacts', status: 'done' });

    await deps.runner.run(deps.instanceDir, composeCommands.upDetached());
    await emitStep(steps, deps.onStep, { name: 'up', status: 'done' });

    // `up` recreated the backend (new image) AND restarted the frontend, so the
    // maintenance lock (ephemeral container fs) is gone. Re-assert it on the
    // fresh backend so the migrate + health window is still gated.
    if (deps.enterMaintenance) {
      await deps.enterMaintenance();
      await emitStep(steps, deps.onStep, { name: 'maintenance-reassert', status: 'done' });
    }

    migrationsAttempted = true;
    await deps.runMigrations();
    await emitStep(steps, deps.onStep, { name: 'migrate', status: 'done' });

    if (deps.restorePlugins) {
      await deps.restorePlugins();
      await emitStep(steps, deps.onStep, { name: 'plugins', status: 'done' });
    }

    const health = await deps.checkHealth();
    if (!isHealthy(health)) {
      await emitStep(steps, deps.onStep, { name: 'health', status: 'failed', detail: `overall=${health.overall}` });
      await runRollback(deps, steps, report, {
        backupId,
        reason: `health ${health.overall}`,
        migrated: migrationsAttempted,
        destructive,
      });
      return report;
    }
    await emitStep(steps, deps.onStep, { name: 'health', status: 'done', detail: 'healthy' });

    // Leave maintenance only after health passes.
    if (deps.exitMaintenance) {
      await deps.exitMaintenance();
      await emitStep(steps, deps.onStep, { name: 'maintenance-exit', status: 'done' });
    }

    report.ok = true;
    return report;
  } catch (err) {
    await emitStep(steps, deps.onStep, { name: 'update', status: 'failed', detail: errMessage(err) });
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
      await emitStep(steps, deps.onStep, {
        name: 'rollback',
        status: 'done',
        detail: `config restored; destructive migrations ran - restore backup ${ctx.backupId} to recover data`,
      });
    } else {
      await emitStep(steps, deps.onStep, { name: 'rollback', status: 'done', detail: ctx.backupId });
    }
  } catch (rollbackErr) {
    await emitStep(steps, deps.onStep, { name: 'rollback', status: 'failed', detail: errMessage(rollbackErr) });
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

/**
 * Record a step into the report AND notify the live-progress hook in one place,
 * so callers (the manager journal) see the step the instant it happens instead
 * of only in the final report. The hook is best-effort: a failure there must
 * never abort or alter the operation.
 */
async function emitStep(
  steps: UpdateStepResult[],
  onStep: ((step: UpdateStepResult) => void | Promise<void>) | undefined,
  step: UpdateStepResult,
): Promise<void> {
  steps.push(step);
  if (!onStep) return;
  try {
    await onStep(step);
  } catch {
    // Progress reporting must never break the update.
  }
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

// ---------------------------------------------------------------------------
// Frontend-only update (plan + execute)
// ---------------------------------------------------------------------------
//
// The frontend is released independently of the core: a new frontend image can
// target the same core range, so an instance on the latest core can still have
// a newer frontend available. The core-driven `planUpdate` reports `up_to_date`
// in that case, so this is the dedicated, lightweight path that swaps ONLY the
// frontend container. It is deliberately simpler than a core update: the
// frontend is stateless, so there is no database migration, no full backup, and
// no maintenance window — just snapshot config (for rollback), recreate the one
// container from the new image, and health-check.

/** The single Compose service a frontend-only update recreates. */
export const FRONTEND_UPDATE_SERVICE = 'frontend';

export interface FrontendUpdatePlanInput {
  instanceId: string;
  /** The frontend version currently installed. */
  currentFrontendVersion: string;
  /** The instance's installed core version (never changed here). */
  coreVersion: string;
  /** The current core release, when known, so its required frontend range is enforced. */
  currentCore?: CoreRelease | null;
  frontendReleases: FrontendRelease[];
  channel?: ReleaseChannel;
  target?: 'latest' | string;
  advisories?: SecurityAdvisory[];
}

export interface FrontendUpdatePlan {
  instanceId: string;
  kind: 'frontend';
  currentFrontendVersion: string;
  targetFrontendVersion: string | null;
  /** No 'warning' here: a frontend swap runs no migrations. */
  status: Exclude<UpdateStatus, 'warning'>;
  frontend: FrontendRelease | null;
  reasons: string[];
  steps: string[];
}

/** Resolves a frontend-only update target and produces a (non-mutating) plan. */
export function planFrontendUpdate(input: FrontendUpdatePlanInput): FrontendUpdatePlan {
  const result = resolveFrontendUpdate({
    currentFrontendVersion: input.currentFrontendVersion,
    coreVersion: input.coreVersion,
    currentCore: input.currentCore ?? null,
    available: input.frontendReleases,
    target: input.target ?? 'latest',
    channel: input.channel ?? 'stable',
    advisories: input.advisories ?? [],
  });

  const base = {
    instanceId: input.instanceId,
    kind: 'frontend' as const,
    currentFrontendVersion: input.currentFrontendVersion,
    reasons: result.reasons,
  };

  if (result.status !== 'ok' || result.selected === null) {
    return { ...base, status: result.status, targetFrontendVersion: null, frontend: null, steps: [] };
  }

  return {
    ...base,
    status: 'ok',
    targetFrontendVersion: result.selected.version,
    frontend: result.selected,
    steps: buildFrontendSteps(input.currentFrontendVersion, result.selected),
  };
}

function buildFrontendSteps(current: string, frontend: FrontendRelease): string[] {
  return [
    'verify signature + checksum of the target frontend image',
    'snapshot the current compose/manifest/lock/.env (for rollback)',
    `write new manifest + lock + .env + compose (frontend ${current} -> ${frontend.version})`,
    `pull frontend image (${frontend.version})`,
    'recreate the frontend (new image) + refresh the app services so the CMS reports the new frontend version (docker compose up -d)',
    're-mount any installed plugins lost to the container recreate (no-op when none are installed)',
    'run health checks',
    'on failure: restore the previous config, recreate the previous containers, and re-mount plugins',
  ];
}

export interface FrontendUpdateExecutionDeps {
  runner: ComposeRunner;
  instanceDir: string;
  /**
   * Capture the pre-update config (compose/manifest/lock/.env) BEFORE any
   * mutation, so a failure can be restored exactly. A failure here aborts the
   * update before anything is mutated.
   */
  snapshot: () => Promise<void>;
  /** Rewrite the instance artifacts with the new frontend image + version. */
  applyArtifacts: () => Promise<void>;
  /**
   * Re-mount composer-installed plugins after the container recreate dropped
   * their vendor/ from the writable layer. No-op when no plugins are installed.
   * Runs after the `up` and before the health check so the verdict reflects the
   * final (plugins re-mounted) state.
   */
  restorePluginState?: () => Promise<void>;
  checkHealth: () => Promise<HealthReport>;
  /** Restore the snapshot config and recreate the previous frontend container. */
  rollback: (reason: string) => Promise<void>;
  /** Live progress hook (see {@link UpdateExecutionDeps.onStep}); best-effort. */
  onStep?: (step: UpdateStepResult) => void | Promise<void>;
  now?: () => string;
}

export interface FrontendUpdateExecutionReport {
  instanceId: string;
  targetFrontendVersion: string;
  ok: boolean;
  rolledBack: boolean;
  steps: UpdateStepResult[];
}

/**
 * Executes an approved, non-blocked frontend-only plan. No backup, no
 * migrations, no maintenance window: the frontend is stateless, so the path is
 * snapshot -> apply -> pull -> recreate frontend -> health, with a config
 * rollback (and a previous-image recreate) on any failure. The MySQL/uploads/
 * plugin volumes are never touched.
 */
export async function executeFrontendUpdate(
  plan: FrontendUpdatePlan,
  deps: FrontendUpdateExecutionDeps,
): Promise<FrontendUpdateExecutionReport> {
  if (plan.status !== 'ok' || plan.frontend === null || plan.targetFrontendVersion === null) {
    throw new Error('Refusing to execute a frontend update plan that is not ok.');
  }

  const steps: UpdateStepResult[] = [];
  const report: FrontendUpdateExecutionReport = {
    instanceId: plan.instanceId,
    targetFrontendVersion: plan.targetFrontendVersion,
    ok: false,
    rolledBack: false,
    steps,
  };

  // Snapshot first — before any mutation. A failure here aborts without rollback.
  try {
    await deps.snapshot();
    await emitStep(steps, deps.onStep, { name: 'snapshot', status: 'done' });
  } catch (err) {
    await emitStep(steps, deps.onStep, { name: 'snapshot', status: 'failed', detail: errMessage(err) });
    return report;
  }

  try {
    await deps.applyArtifacts();
    await emitStep(steps, deps.onStep, { name: 'apply-artifacts', status: 'done' });

    await deps.runner.run(deps.instanceDir, composeCommands.pullService(FRONTEND_UPDATE_SERVICE));
    await emitStep(steps, deps.onStep, { name: 'pull', status: 'done', detail: plan.targetFrontendVersion });

    // `up -d` recreates the frontend (new image) AND any app service whose env
    // changed — notably the backend, which reads SELFHELP_FRONTEND_VERSION. A
    // `--no-deps frontend` swap leaves the backend on the old version env, so
    // the CMS system page keeps reporting the previous frontend version even
    // though the container was swapped. Recreating refreshes that stamp.
    await deps.runner.run(deps.instanceDir, composeCommands.upDetached());
    await emitStep(steps, deps.onStep, { name: 'up', status: 'done', detail: FRONTEND_UPDATE_SERVICE });

    // Recreating the Symfony containers drops composer-installed plugin vendor/
    // from their writable layer; re-extract the snapshot before health-checking.
    if (deps.restorePluginState) {
      await deps.restorePluginState();
      await emitStep(steps, deps.onStep, { name: 'plugins', status: 'done' });
    }

    const health = await deps.checkHealth();
    if (!isHealthy(health)) {
      await emitStep(steps, deps.onStep, { name: 'health', status: 'failed', detail: `overall=${health.overall}` });
      await runFrontendRollback(deps, steps, report, `health ${health.overall}`);
      return report;
    }
    await emitStep(steps, deps.onStep, { name: 'health', status: 'done', detail: 'healthy' });

    report.ok = true;
    return report;
  } catch (err) {
    await emitStep(steps, deps.onStep, { name: 'update', status: 'failed', detail: errMessage(err) });
    await runFrontendRollback(deps, steps, report, errMessage(err));
    return report;
  }
}

async function runFrontendRollback(
  deps: FrontendUpdateExecutionDeps,
  steps: UpdateStepResult[],
  report: FrontendUpdateExecutionReport,
  reason: string,
): Promise<void> {
  try {
    await deps.rollback(reason);
    report.rolledBack = true;
    await emitStep(steps, deps.onStep, { name: 'rollback', status: 'done', detail: reason });
  } catch (rollbackErr) {
    await emitStep(steps, deps.onStep, { name: 'rollback', status: 'failed', detail: errMessage(rollbackErr) });
  }
}
