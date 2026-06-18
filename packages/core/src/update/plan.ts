// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Core update dry-run planning: resolve a target, evaluate plugin compatibility
 * + advisories, run the preflight and build the human-readable step list.
 */
import type {
  CoreRelease,
  FrontendRelease,
  PluginRelease,
  PreflightOption,
  ReleaseChannel,
  SecurityAdvisory,
  UpdatePreflightResult,
} from '@shm/schemas';
import {
  evaluatePluginAgainstTargetCore,
  pickFrontendForCore,
  resolveCoreTarget,
  type PluginUpdateBlock,
} from '@shm/resolver';
import { runPreflight, type PreflightResourceFacts, type PreflightThresholds } from '../preflight.js';
import type { MysqlMajorUpgradeDecision } from './mysql.js';

export type UpdateStatus = 'ok' | 'warning' | 'blocked' | 'up_to_date';

export interface UpdatePlanInput {
  instanceId: string;
  currentVersion: string;
  channel?: ReleaseChannel;
  target?: string;
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
