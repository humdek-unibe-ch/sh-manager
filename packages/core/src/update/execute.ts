// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Core update execution: the ordered, safe, rollback-on-failure update
 * (backup -> snapshot -> maintenance -> pull/apply/up -> migrate -> health),
 * with automatic rollback to the pre-update snapshot/backup on any failure.
 * Volumes (DB/uploads/plugins) always survive.
 */
import { composeCommands, type ComposeRunner } from '@shm/docker';
import { isHealthy, type HealthReport } from '../health.js';
import type { ApprovedUpdate } from '../instance-scope.js';
import type { UpdatePlan } from './plan.js';
import { emitStep, errMessage, type UpdateStepResult } from './shared.js';

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
