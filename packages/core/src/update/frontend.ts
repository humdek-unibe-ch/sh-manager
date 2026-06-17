// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Frontend-only update (plan + execute). The frontend is released independently
 * of the core and is stateless, so this is the lightweight path: snapshot ->
 * apply -> pull -> recreate the frontend -> health, with a config rollback on
 * failure. No backup, no migrations, no maintenance window; volumes untouched.
 */
import type { CoreRelease, FrontendRelease, ReleaseChannel, SecurityAdvisory } from '@shm/schemas';
import { resolveFrontendUpdate } from '@shm/resolver';
import { composeCommands, type ComposeRunner } from '@shm/docker';
import { isHealthy, type HealthReport } from '../health.js';
import type { UpdateStatus } from './plan.js';
import { emitStep, errMessage, type UpdateStepResult } from './shared.js';

export const FRONTEND_UPDATE_SERVICE = 'frontend';

export interface FrontendUpdatePlanInput {
  instanceId: string;
  /** The frontend version currently installed. */
  currentFrontendVersion: string;
  /** The instance's installed core version (never changed here). */
  coreVersion: string;
  /** The current core release, when known, so its required frontend range is enforced. */
  currentCore?: CoreRelease | null;
  /**
   * The running core's required frontend range from the instance lock — the
   * authoritative fallback enforced when {@link currentCore} is unavailable
   * (core release no longer in the registry).
   */
  currentCoreRequiredFrontendRange?: string | null;
  /**
   * Fail closed when the running core's required frontend range cannot be
   * determined (see {@link FrontendUpdateInput.requireCoreFrontendRange}). The
   * instance frontend-update action sets this so the constraint is never bypassed.
   */
  requireCoreFrontendRange?: boolean;
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
    currentCoreRequiredFrontendRange: input.currentCoreRequiredFrontendRange ?? null,
    requireCoreFrontendRange: input.requireCoreFrontendRange ?? false,
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
