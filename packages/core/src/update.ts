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
  channel?: 'stable' | 'beta' | 'nightly';
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

export interface UpdateExecutionDeps {
  runner: ComposeRunner;
  instanceDir: string;
  takeBackup: () => Promise<{ backupId: string }>;
  applyArtifacts: () => Promise<void>;
  runMigrations: () => Promise<void>;
  checkHealth: () => Promise<HealthReport>;
  rollback: (ctx: { backupId: string; reason: string }) => Promise<void>;
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

  try {
    await deps.runner.run(deps.instanceDir, composeCommands.pull());
    steps.push({ name: 'pull', status: 'done' });

    await deps.applyArtifacts();
    steps.push({ name: 'apply-artifacts', status: 'done' });

    await deps.runner.run(deps.instanceDir, composeCommands.upDetached());
    steps.push({ name: 'up', status: 'done' });

    await deps.runMigrations();
    steps.push({ name: 'migrate', status: 'done' });

    const health = await deps.checkHealth();
    if (!isHealthy(health)) {
      steps.push({ name: 'health', status: 'failed', detail: `overall=${health.overall}` });
      await deps.rollback({ backupId, reason: `health ${health.overall}` });
      steps.push({ name: 'rollback', status: 'done', detail: backupId });
      report.rolledBack = true;
      return report;
    }
    steps.push({ name: 'health', status: 'done', detail: 'healthy' });

    report.ok = true;
    return report;
  } catch (err) {
    steps.push({ name: 'update', status: 'failed', detail: errMessage(err) });
    try {
      await deps.rollback({ backupId, reason: errMessage(err) });
      steps.push({ name: 'rollback', status: 'done', detail: backupId });
      report.rolledBack = true;
    } catch (rollbackErr) {
      steps.push({ name: 'rollback', status: 'failed', detail: errMessage(rollbackErr) });
    }
    return report;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
