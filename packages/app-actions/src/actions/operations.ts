// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * CMS <-> Manager operation loop: consume backend-requested core/frontend
 * updates, plus the managed-mode plugin operation drain and installed-plugin
 * inspection.
 */
import {
  drainOperations,
  finalizePluginOperations,
  processNextOperation,
  type ApprovedUpdate,
  type BackendOperationsClient,
  type OperationExecutor,
  type OperationLifecycleStatus,
  type PendingOperation,
  type PendingPluginOperation,
  type PhaseReporter,
  type PluginDrainReport,
  type ProcessOutcome,
  type UpdateExecutionReport,
} from '@shm/core';
import { pluginSeams, readManifestFriendly, type ActionDeps, type PluginDrainOverrides } from './shared.js';
import { instanceFrontendUpdate, instanceUpdate } from './update.js';

// ---------------------------------------------------------------------------
// CMS <-> Manager update loop (consume backend-requested operations)
// ---------------------------------------------------------------------------

/**
 * Builds the executor that the operations consumer runs for an approved update.
 * It reuses the same resolve+execute machinery as {@link instanceUpdate} and
 * streams coarse lifecycle phases back through `phase(...)`. A blocked /
 * up-to-date plan is surfaced as a failed report so the loop writes it back
 * instead of silently doing nothing.
 */
export function buildOperationExecutor(deps: ActionDeps): OperationExecutor {
  return async (approved, op, phase) => {
    if (op.kind === 'frontend') {
      return executeFrontendOperation(deps, approved, op, phase);
    }

    await phase('preflight_running', 10, `Resolving update to ${op.targetVersion}.`);
    await phase('backup_running', 25);

    const res = await instanceUpdate(deps, approved.instanceId, {
      target: op.targetVersion,
      acceptMigrationRisk: op.acceptedMigrationRisk,
    });

    if (!res.executed || !res.report) {
      return {
        instanceId: approved.instanceId,
        targetVersion: op.targetVersion,
        ok: false,
        rolledBack: false,
        steps: [{ name: 'plan', status: 'failed', detail: `plan status: ${res.plan.status}` }],
      };
    }

    await phase('health_check_running', 90);
    return res.report;
  };
}

/**
 * Runs a CMS-requested FRONTEND-only operation. It reuses
 * {@link instanceFrontendUpdate} and maps its lightweight report onto the
 * shared {@link UpdateExecutionReport} shape (target = the frontend version)
 * so the operations loop writes it back like any other update.
 */
async function executeFrontendOperation(
  deps: ActionDeps,
  approved: ApprovedUpdate,
  op: PendingOperation,
  phase: PhaseReporter,
): Promise<UpdateExecutionReport> {
  const targetFrontend = op.targetFrontendVersion ?? op.targetVersion;
  await phase('preflight_running', 10, `Resolving frontend update to ${targetFrontend}.`);

  const res = await instanceFrontendUpdate(deps, approved.instanceId, { target: targetFrontend });

  if (!res.executed || !res.report) {
    return {
      instanceId: approved.instanceId,
      targetVersion: targetFrontend,
      ok: false,
      rolledBack: false,
      steps: [{ name: 'plan', status: 'failed', detail: `plan status: ${res.plan.status}` }],
    };
  }

  await phase('update_running', 60);
  await phase('health_check_running', 90);
  return {
    instanceId: res.report.instanceId,
    targetVersion: res.report.targetFrontendVersion,
    ok: res.report.ok,
    rolledBack: res.report.rolledBack,
    steps: res.report.steps,
  };
}

/**
 * Claims and processes the next pending CMS-requested operation for an
 * instance. The trusted instance id is taken from the server-side manifest, and
 * the authenticated {@link BackendOperationsClient} is injected so the transport
 * is testable.
 */
export async function processInstanceOperations(
  deps: ActionDeps,
  instanceId: string,
  client: BackendOperationsClient,
): Promise<ProcessOutcome> {
  const manifest = await readManifestFriendly(deps, instanceId);
  return processNextOperation({
    trustedInstanceId: manifest.instanceId,
    client,
    execute: buildOperationExecutor(deps),
    ...(deps.now ? { now: deps.now } : {}),
  });
}

/**
 * Drains every pending CMS-requested operation for an instance in a single
 * invocation (claim → execute → write-back, repeated until the backend is idle).
 * A supervised trigger (systemd service / cron) calls this each tick so requests
 * never stay on "requested".
 */
export async function drainInstanceOperations(
  deps: ActionDeps,
  instanceId: string,
  client: BackendOperationsClient,
  onPhase?: (
    op: PendingOperation,
    status: OperationLifecycleStatus,
    progressPercent: number,
    detail?: string,
  ) => void | Promise<void>,
): Promise<ProcessOutcome[]> {
  const manifest = await readManifestFriendly(deps, instanceId);
  return drainOperations({
    trustedInstanceId: manifest.instanceId,
    client,
    execute: buildOperationExecutor(deps),
    ...(deps.now ? { now: deps.now } : {}),
    ...(onPhase ? { onPhase } : {}),
  });
}

// ---------------------------------------------------------------------------
// CMS plugin operations (managed install mode: the manager is the operator)
// ---------------------------------------------------------------------------

/** One-line human summary of a parked plugin operation, for phases/logs. */
export function describePluginOperation(op: PendingPluginOperation): string {
  const verb =
    op.type === 'install'
      ? 'Installing'
      : op.type === 'update'
        ? 'Updating'
        : op.type === 'purge'
          ? 'Purging'
          : 'Uninstalling';
  const version = op.version ? ` ${op.version}` : '';
  return `${verb} plugin ${op.pluginId}${version}`;
}

/** Cheap peek used by pollers: is any managed plugin operation parked for us? */
export async function hasPendingPluginOperations(
  deps: ActionDeps,
  instanceId: string,
  overrides?: PluginDrainOverrides,
): Promise<boolean> {
  const { client } = pluginSeams(deps, instanceId, overrides);
  return (await client.listPendingOperations()).length > 0;
}

/**
 * Drains parked managed-mode plugin operations (install/update/uninstall):
 * runs the runbook's composer step in the backend, finalizes via
 * `selfhelp:plugin:run-operation`, enables new installs, then snapshots the
 * composer state to the shared plugin volume, syncs worker + scheduler from
 * it, and restarts the Symfony services so the new bundles load everywhere.
 */
export async function drainInstancePluginOperations(
  deps: ActionDeps,
  instanceId: string,
  overrides?: PluginDrainOverrides,
): Promise<PluginDrainReport> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const { client, execDeps } = pluginSeams(deps, instanceId, overrides);
  const operations = await client.listPendingOperations();
  if (operations.length === 0) return { outcomes: [], restarted: false };
  // Surface WHAT is about to run before we start (label the journaled op).
  if (overrides?.onPlanned) {
    try {
      await overrides.onPlanned(operations);
    } catch {
      // Labeling is best-effort; never let it block the actual drain.
    }
  }
  return finalizePluginOperations({ operations, coreVersion: manifest.versions.selfhelp }, execDeps);
}

/** Operator-facing view of one plugin actually installed in a running instance. */
export interface InstalledPluginInfo {
  id: string;
  version: string;
  enabled: boolean;
}

/**
 * Read the plugins ACTUALLY installed in a running instance, straight from its
 * `plugins` table (the durable source of truth), rather than the possibly-stale
 * `installedPlugins` recorded in the manifest. Requires the instance to be up
 * (it execs a read-only query inside the backend container). Throws when the
 * instance is down / has no plugin support; the manager treats that as "unknown"
 * and falls back to the manifest.
 */
export async function instanceListInstalledPlugins(
  deps: ActionDeps,
  instanceId: string,
  overrides?: PluginDrainOverrides,
): Promise<InstalledPluginInfo[]> {
  const { client } = pluginSeams(deps, instanceId, overrides);
  const rows = await client.listInstalledPlugins();
  return rows
    .map((r) => ({ id: r.pluginId, version: r.version, enabled: r.enabled }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
