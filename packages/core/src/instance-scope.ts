// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance-scope enforcement (security-critical).
 *
 * Hard rules from the distribution plan:
 * - CMS admin update management is scoped only to the *current* instance.
 * - The frontend must not send arbitrary `instanceId` values for execution.
 * - The backend/manager must not trust a user-provided `instanceId`.
 * - Cross-instance update attempts must be denied and logged.
 *
 * The trusted instance identity is always derived server-side (from the
 * instance manifest / mounted configuration). Any request-supplied id is only
 * accepted if it exactly matches the trusted id; otherwise it is rejected and
 * an audit event is produced for logging.
 */
import type { InstanceManifest, UpdateApprovalRequest } from '@shm/schemas';

export interface ScopeAuditEvent {
  at: string;
  actorUserId: number;
  requestedInstanceId: string | null;
  trustedInstanceId: string;
  allowed: boolean;
  reason: string;
}

export class CrossInstanceError extends Error {
  constructor(readonly audit: ScopeAuditEvent) {
    super(audit.reason);
    this.name = 'CrossInstanceError';
  }
}

/** Derives the trusted instance id from server-side manifest, never the request. */
export function deriveTrustedInstanceId(manifest: Pick<InstanceManifest, 'instanceId'>): string {
  return manifest.instanceId;
}

export interface ScopeCheckInput {
  requestedInstanceId?: string | null;
  trustedInstanceId: string;
  actorUserId: number;
  now?: () => string;
}

/**
 * Verifies that an operation stays within the current instance. Returns an
 * audit event on success; throws {@link CrossInstanceError} (carrying the
 * audit event to be logged) on a cross-instance attempt.
 */
export function verifyInstanceScope(input: ScopeCheckInput): ScopeAuditEvent {
  const at = (input.now ?? (() => new Date().toISOString()))();
  const requested = input.requestedInstanceId ?? null;

  if (requested !== null && requested !== input.trustedInstanceId) {
    const audit: ScopeAuditEvent = {
      at,
      actorUserId: input.actorUserId,
      requestedInstanceId: requested,
      trustedInstanceId: input.trustedInstanceId,
      allowed: false,
      reason: `Cross-instance attempt denied: requested "${requested}" but this instance is "${input.trustedInstanceId}".`,
    };
    throw new CrossInstanceError(audit);
  }

  return {
    at,
    actorUserId: input.actorUserId,
    requestedInstanceId: requested,
    trustedInstanceId: input.trustedInstanceId,
    allowed: true,
    reason: 'In scope.',
  };
}

export interface PendingApproval {
  preflightId: string;
  instanceId: string;
  targetVersion: string;
  approvalToken: string;
  destructiveMigration: boolean;
}

export interface ApprovedUpdate {
  instanceId: string;
  targetVersion: string;
  preflightId: string;
  approvedByUserId: number;
  audit: ScopeAuditEvent;
}

/**
 * Validates an update approval request against the server-derived trusted
 * instance id and a pending preflight. The returned {@link ApprovedUpdate}
 * always carries the trusted instance id — never the request-supplied one.
 */
export function verifyUpdateApproval(
  request: UpdateApprovalRequest,
  trustedInstanceId: string,
  pending: PendingApproval,
  now?: () => string,
): ApprovedUpdate {
  // Scope first: a mismatching request instance id is a cross-instance attempt.
  const audit = verifyInstanceScope({
    requestedInstanceId: request.instanceId,
    trustedInstanceId,
    actorUserId: request.approvedByUserId,
    now,
  });

  if (pending.instanceId !== trustedInstanceId) {
    throw new CrossInstanceError({
      ...audit,
      allowed: false,
      reason: `Pending preflight belongs to "${pending.instanceId}", not "${trustedInstanceId}".`,
    });
  }
  if (request.preflightId !== pending.preflightId) {
    throw new Error('Approval references an unknown or stale preflight id.');
  }
  if (request.approvalToken !== pending.approvalToken) {
    throw new Error('Approval token does not match the pending preflight.');
  }
  if (request.targetVersion !== pending.targetVersion) {
    throw new Error('Approved target version does not match the preflight target.');
  }
  if (pending.destructiveMigration && !request.acceptedMigrationRisk) {
    throw new Error('Destructive migration requires explicit acceptedMigrationRisk = true.');
  }

  return {
    instanceId: trustedInstanceId,
    targetVersion: pending.targetVersion,
    preflightId: pending.preflightId,
    approvedByUserId: request.approvedByUserId,
    audit,
  };
}
