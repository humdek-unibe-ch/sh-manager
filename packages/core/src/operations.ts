// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * CMS <-> Manager update loop (the missing half of the distribution plan's
 * update flow).
 *
 * The CMS admin records an instance-scoped update *request* in the backend
 * (`system_update_operations`). This module is the manager-side consumer that:
 *
 *   1. claims the next pending operation for the CURRENT instance over an
 *      authenticated backend transport ({@link BackendOperationsClient});
 *   2. re-verifies instance scope + approval server-side via
 *      {@link verifyUpdateApproval} (a request for another instance, or a
 *      destructive update without accepted risk, is rejected and written back);
 *   3. executes the approved update, writing the granular lifecycle status back
 *      to the backend as each phase progresses, so the CMS UI shows real state
 *      instead of staying on "requested" forever;
 *   4. maps the execution report to a terminal status (succeeded / failed /
 *      rolled_back / rollback_failed).
 *
 * The trusted instance id is ALWAYS the server-derived one (from the instance
 * manifest); a backend that returns an operation for a different instance is a
 * cross-instance attempt and is rejected.
 */
import {
  CrossInstanceError,
  verifyUpdateApproval,
  type ApprovedUpdate,
  type PendingApproval,
} from './instance-scope.js';
import type { UpdateExecutionReport } from './update.js';

/** Full operation lifecycle written back to the backend (plan: "Update states"). */
export const OPERATION_LIFECYCLE = [
  'requested',
  'accepted',
  'preflight_running',
  'preflight_failed',
  'backup_running',
  'update_running',
  'migration_running',
  'health_check_running',
  'succeeded',
  'failed',
  'rollback_running',
  'rolled_back',
  'rollback_failed',
] as const;

export type OperationLifecycleStatus = (typeof OPERATION_LIFECYCLE)[number];

/** A pending operation as the backend exposes it to the manager. */
export interface PendingOperation {
  operationId: string;
  instanceId: string;
  targetVersion: string;
  preflightId: string;
  approvalToken: string;
  approvedByUserId: number;
  acceptedMigrationRisk: boolean;
  destructiveMigration: boolean;
}

export interface OperationStatusUpdate {
  operationId: string;
  status: OperationLifecycleStatus;
  progressPercent: number;
  message?: string;
  steps?: { name: string; status: string; detail?: string }[];
}

/**
 * Authenticated transport to a single instance's backend. Implementations bind
 * to ONE instance via its per-instance manager token (never a shared/global
 * credential), so one instance can never read or write another's operations.
 */
export interface BackendOperationsClient {
  /** The next claimable operation for this instance, or null when idle. */
  fetchPending(instanceId: string): Promise<PendingOperation | null>;
  /** Persists a status/progress update back to the backend. */
  postStatus(update: OperationStatusUpdate): Promise<void>;
}

/** Live phase callback the executor uses to stream progress to the backend. */
export type PhaseReporter = (
  status: OperationLifecycleStatus,
  progressPercent: number,
  detail?: string,
) => Promise<void>;

/**
 * Runs the approved update. Injected so the heavy Docker/registry wiring lives
 * in the CLI layer and the consumer stays unit-testable. The executor MUST call
 * `phase(...)` as it moves through preflight/backup/update/migration/health.
 */
export type OperationExecutor = (
  approved: ApprovedUpdate,
  op: PendingOperation,
  phase: PhaseReporter,
) => Promise<UpdateExecutionReport>;

export interface ProcessOperationsDeps {
  /** Server-derived trusted instance id (from the manifest). */
  trustedInstanceId: string;
  client: BackendOperationsClient;
  execute: OperationExecutor;
  now?: () => string;
}

export type ProcessOutcome =
  | { result: 'noop' }
  | { result: 'rejected'; operationId: string; status: OperationLifecycleStatus; reason: string }
  | { result: 'completed'; operationId: string; status: OperationLifecycleStatus; report: UpdateExecutionReport };

/**
 * Claims and processes the next pending operation for the current instance.
 * Returns `noop` when nothing is pending. Every rejection and result is written
 * back to the backend so the CMS UI never stalls on "requested".
 */
export async function processNextOperation(deps: ProcessOperationsDeps): Promise<ProcessOutcome> {
  const { trustedInstanceId, client, execute } = deps;

  const op = await client.fetchPending(trustedInstanceId);
  if (op === null) {
    return { result: 'noop' };
  }

  // 1. Re-verify scope + approval server-side. A cross-instance operation, a
  //    stale/forged token, or a destructive update without accepted risk is
  //    rejected here and written back — never executed.
  let approved: ApprovedUpdate;
  try {
    const pending: PendingApproval = {
      preflightId: op.preflightId,
      instanceId: op.instanceId,
      targetVersion: op.targetVersion,
      approvalToken: op.approvalToken,
      destructiveMigration: op.destructiveMigration,
    };
    approved = verifyUpdateApproval(
      {
        instanceId: op.instanceId,
        targetVersion: op.targetVersion,
        preflightId: op.preflightId,
        approvedByUserId: op.approvedByUserId,
        approvalToken: op.approvalToken,
        acceptedMigrationRisk: op.acceptedMigrationRisk,
      },
      trustedInstanceId,
      pending,
      deps.now,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Cross-instance is a hard security rejection; everything else is an
    // approval/preflight failure. Both are written back so the UI updates.
    const status: OperationLifecycleStatus =
      err instanceof CrossInstanceError ? 'failed' : 'preflight_failed';
    await client.postStatus({ operationId: op.operationId, status, progressPercent: 0, message: reason });
    return { result: 'rejected', operationId: op.operationId, status, reason };
  }

  // 2. Accept, then execute with live phase write-backs.
  await client.postStatus({
    operationId: op.operationId,
    status: 'accepted',
    progressPercent: 5,
    message: `Accepted update to ${op.targetVersion}.`,
  });

  const phase: PhaseReporter = async (status, progressPercent, detail) => {
    await client.postStatus({
      operationId: op.operationId,
      status,
      progressPercent,
      ...(detail !== undefined ? { message: detail } : {}),
    });
  };

  let report: UpdateExecutionReport;
  try {
    report = await execute(approved, op, phase);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await client.postStatus({ operationId: op.operationId, status: 'failed', progressPercent: 100, message: reason });
    return { result: 'rejected', operationId: op.operationId, status: 'failed', reason };
  }

  // 3. Terminal status from the execution report.
  const status = terminalStatus(report);
  await client.postStatus({
    operationId: op.operationId,
    status,
    progressPercent: 100,
    steps: report.steps.map((s) => ({ name: s.name, status: s.status, ...(s.detail !== undefined ? { detail: s.detail } : {}) })),
    message: terminalMessage(status, report),
  });

  return { result: 'completed', operationId: op.operationId, status, report };
}

/** Maps an {@link UpdateExecutionReport} to the terminal lifecycle status. */
export function terminalStatus(report: UpdateExecutionReport): OperationLifecycleStatus {
  if (report.ok) return 'succeeded';
  if (report.rolledBack) return 'rolled_back';
  if (report.steps.some((s) => s.name === 'rollback' && s.status === 'failed')) return 'rollback_failed';
  return 'failed';
}

function terminalMessage(status: OperationLifecycleStatus, report: UpdateExecutionReport): string {
  switch (status) {
    case 'succeeded':
      return `Update to ${report.targetVersion} completed successfully.`;
    case 'rolled_back':
      return `Update to ${report.targetVersion} failed and was rolled back to the pre-update backup.`;
    case 'rollback_failed':
      return `Update to ${report.targetVersion} failed AND rollback failed — restore the verified backup manually.`;
    default:
      return `Update to ${report.targetVersion} failed before any change was applied.`;
  }
}
