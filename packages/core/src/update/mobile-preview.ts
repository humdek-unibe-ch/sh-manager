// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Mobile-preview-only update (plan + execute). The `selfhelp-mobile-preview`
 * image is released on the mobile repo's own tags, independently of the core,
 * and is a stateless front door (Expo web export + a thin `/cms-api` proxy to
 * the PRIVATE backend). So this is the lightweight path — a peer of the
 * frontend-only update: snapshot -> apply -> pull -> recreate ONLY the preview
 * container (`--no-deps`) -> health, with a config rollback on failure. No
 * backup, no migrations, no maintenance window; volumes and the core stack are
 * never touched (the backend keeps serving while the preview swaps).
 */
import type { MobilePreviewRelease, ReleaseChannel } from '@shm/schemas';
import { resolveMobilePreviewUpdate } from '@shm/resolver';
import { composeCommands, type ComposeRunner } from '@shm/docker';
import { isHealthy, type HealthReport } from '../health.js';
import type { UpdateStatus } from './plan.js';
import { emitStep, errMessage, type UpdateStepResult } from './shared.js';

/** Compose service name of the optional mobile-preview container. */
export const MOBILE_PREVIEW_UPDATE_SERVICE = 'mobile-preview';

export interface MobilePreviewUpdatePlanInput {
  instanceId: string;
  /** The mobile-preview version currently installed. */
  currentMobilePreviewVersion: string;
  /** The instance's installed core version (never changed here). */
  coreVersion: string;
  mobilePreviewReleases: MobilePreviewRelease[];
  channel?: ReleaseChannel;
  target?: string;
}

export interface MobilePreviewUpdatePlan {
  instanceId: string;
  kind: 'mobile-preview';
  currentMobilePreviewVersion: string;
  targetMobilePreviewVersion: string | null;
  /** No 'warning' here: a preview swap runs no migrations. */
  status: Exclude<UpdateStatus, 'warning'>;
  mobilePreview: MobilePreviewRelease | null;
  reasons: string[];
  steps: string[];
}

/** Resolves a mobile-preview-only update target and produces a (non-mutating) plan. */
export function planMobilePreviewUpdate(input: MobilePreviewUpdatePlanInput): MobilePreviewUpdatePlan {
  const result = resolveMobilePreviewUpdate({
    currentMobilePreviewVersion: input.currentMobilePreviewVersion,
    coreVersion: input.coreVersion,
    available: input.mobilePreviewReleases,
    target: input.target ?? 'latest',
    channel: input.channel ?? 'stable',
  });

  const base = {
    instanceId: input.instanceId,
    kind: 'mobile-preview' as const,
    currentMobilePreviewVersion: input.currentMobilePreviewVersion,
    reasons: result.reasons,
  };

  if (result.status !== 'ok' || result.selected === null) {
    return {
      ...base,
      status: result.status,
      targetMobilePreviewVersion: null,
      mobilePreview: null,
      steps: [],
    };
  }

  return {
    ...base,
    status: 'ok',
    targetMobilePreviewVersion: result.selected.version,
    mobilePreview: result.selected,
    steps: buildMobilePreviewSteps(input.currentMobilePreviewVersion, result.selected),
  };
}

function buildMobilePreviewSteps(current: string, preview: MobilePreviewRelease): string[] {
  return [
    'verify signature + checksum of the target mobile-preview image',
    'snapshot the current compose/manifest/lock (for rollback)',
    `write new manifest + lock + compose (mobile preview ${current} -> ${preview.version})`,
    `pull mobile-preview image (${preview.version})`,
    'recreate ONLY the mobile-preview container (docker compose up -d --no-deps mobile-preview); the core stack keeps serving',
    'run health checks',
    'on failure: restore the previous config and recreate the previous mobile-preview container',
  ];
}

export interface MobilePreviewUpdateExecutionDeps {
  runner: ComposeRunner;
  instanceDir: string;
  /**
   * Capture the pre-update config (compose/manifest/lock) BEFORE any mutation,
   * so a failure can be restored exactly. A failure here aborts the update
   * before anything is mutated.
   */
  snapshot: () => Promise<void>;
  /** Rewrite the instance artifacts with the new mobile-preview image + version. */
  applyArtifacts: () => Promise<void>;
  checkHealth: () => Promise<HealthReport>;
  /** Restore the snapshot config and recreate the previous mobile-preview container. */
  rollback: (reason: string) => Promise<void>;
  /** Live progress hook (see {@link UpdateExecutionDeps.onStep}); best-effort. */
  onStep?: (step: UpdateStepResult) => void | Promise<void>;
  now?: () => string;
}

export interface MobilePreviewUpdateExecutionReport {
  instanceId: string;
  targetMobilePreviewVersion: string;
  ok: boolean;
  rolledBack: boolean;
  steps: UpdateStepResult[];
}

/**
 * Executes an approved, non-blocked mobile-preview-only plan. No backup, no
 * migrations, no maintenance window: the preview is stateless and core-coupled
 * only through the runtime proxy, so the path is snapshot -> apply -> pull ->
 * recreate the preview (`--no-deps`) -> health, with a config rollback (and a
 * previous-image recreate) on any failure. The core stack and all volumes are
 * never touched.
 */
export async function executeMobilePreviewUpdate(
  plan: MobilePreviewUpdatePlan,
  deps: MobilePreviewUpdateExecutionDeps,
): Promise<MobilePreviewUpdateExecutionReport> {
  if (plan.status !== 'ok' || plan.mobilePreview === null || plan.targetMobilePreviewVersion === null) {
    throw new Error('Refusing to execute a mobile-preview update plan that is not ok.');
  }

  const steps: UpdateStepResult[] = [];
  const report: MobilePreviewUpdateExecutionReport = {
    instanceId: plan.instanceId,
    targetMobilePreviewVersion: plan.targetMobilePreviewVersion,
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

    await deps.runner.run(deps.instanceDir, composeCommands.pullService(MOBILE_PREVIEW_UPDATE_SERVICE));
    await emitStep(steps, deps.onStep, {
      name: 'pull',
      status: 'done',
      detail: plan.targetMobilePreviewVersion,
    });

    // `--no-deps` recreates ONLY the preview container. Unlike the frontend
    // swap, no other service reads the preview version (the backend never sees
    // it), so the core stack must NOT be recreated — it keeps serving traffic.
    await deps.runner.run(deps.instanceDir, composeCommands.upService(MOBILE_PREVIEW_UPDATE_SERVICE));
    await emitStep(steps, deps.onStep, { name: 'up', status: 'done', detail: MOBILE_PREVIEW_UPDATE_SERVICE });

    const health = await deps.checkHealth();
    if (!isHealthy(health)) {
      await emitStep(steps, deps.onStep, { name: 'health', status: 'failed', detail: `overall=${health.overall}` });
      await runMobilePreviewRollback(deps, steps, report, `health ${health.overall}`);
      return report;
    }
    await emitStep(steps, deps.onStep, { name: 'health', status: 'done', detail: 'healthy' });

    report.ok = true;
    return report;
  } catch (err) {
    await emitStep(steps, deps.onStep, { name: 'update', status: 'failed', detail: errMessage(err) });
    await runMobilePreviewRollback(deps, steps, report, errMessage(err));
    return report;
  }
}

async function runMobilePreviewRollback(
  deps: MobilePreviewUpdateExecutionDeps,
  steps: UpdateStepResult[],
  report: MobilePreviewUpdateExecutionReport,
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
