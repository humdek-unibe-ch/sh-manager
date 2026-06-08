// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { UpdateApprovalRequest } from '@shm/schemas';
import {
  CrossInstanceError,
  deriveTrustedInstanceId,
  verifyInstanceScope,
  verifyUpdateApproval,
  type PendingApproval,
} from './instance-scope.js';

const now = () => '2026-06-05T10:00:00.000Z';

describe('verifyInstanceScope', () => {
  it('allows a matching (or absent) instance id', () => {
    expect(verifyInstanceScope({ requestedInstanceId: 'website1', trustedInstanceId: 'website1', actorUserId: 7, now }).allowed).toBe(true);
    expect(verifyInstanceScope({ requestedInstanceId: null, trustedInstanceId: 'website1', actorUserId: 7, now }).allowed).toBe(true);
  });

  it('denies and produces an audit event for a cross-instance attempt', () => {
    try {
      verifyInstanceScope({ requestedInstanceId: 'website2', trustedInstanceId: 'website1', actorUserId: 42, now });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CrossInstanceError);
      const audit = (err as CrossInstanceError).audit;
      expect(audit.allowed).toBe(false);
      expect(audit.actorUserId).toBe(42);
      expect(audit.requestedInstanceId).toBe('website2');
      expect(audit.trustedInstanceId).toBe('website1');
      expect(audit.reason).toMatch(/cross-instance/i);
    }
  });

  it('derives the trusted id from the manifest, not the request', () => {
    expect(deriveTrustedInstanceId({ instanceId: 'website1' })).toBe('website1');
  });
});

describe('verifyUpdateApproval', () => {
  const pending: PendingApproval = {
    preflightId: 'pf-123',
    instanceId: 'website1',
    targetVersion: '1.5.0',
    approvalToken: 'tok-abc',
    destructiveMigration: false,
  };
  const baseReq: UpdateApprovalRequest = {
    instanceId: 'website1',
    targetVersion: '1.5.0',
    preflightId: 'pf-123',
    approvedByUserId: 7,
    approvalToken: 'tok-abc',
    acceptedMigrationRisk: false,
  };

  it('approves a valid, in-scope request and pins the trusted instance id', () => {
    const approved = verifyUpdateApproval({ ...baseReq, instanceId: 'website1' }, 'website1', pending, now);
    expect(approved.instanceId).toBe('website1');
    expect(approved.targetVersion).toBe('1.5.0');
  });

  it('rejects a cross-instance approval (browser-supplied instanceId differs)', () => {
    expect(() => verifyUpdateApproval({ ...baseReq, instanceId: 'website2' }, 'website1', pending, now)).toThrow(CrossInstanceError);
  });

  it('rejects a stale preflight id or wrong token', () => {
    expect(() => verifyUpdateApproval({ ...baseReq, preflightId: 'old' }, 'website1', pending, now)).toThrow(/stale preflight/i);
    expect(() => verifyUpdateApproval({ ...baseReq, approvalToken: 'wrong' }, 'website1', pending, now)).toThrow(/token/i);
  });

  it('requires acceptedMigrationRisk for destructive migrations', () => {
    const destructive = { ...pending, destructiveMigration: true };
    expect(() => verifyUpdateApproval(baseReq, 'website1', destructive, now)).toThrow(/acceptedMigrationRisk/);
    const ok = verifyUpdateApproval({ ...baseReq, acceptedMigrationRisk: true }, 'website1', destructive, now);
    expect(ok.targetVersion).toBe('1.5.0');
  });
});
