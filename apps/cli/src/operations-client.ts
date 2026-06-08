// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * HTTP transport between the manager and ONE instance's backend for the
 * CMS<->Manager update loop.
 *
 * Security model:
 * - The client is bound to a single instance id + that instance's per-instance
 *   manager token (a bearer secret). It never carries a shared/global
 *   credential, so it cannot read or write another instance's operations.
 * - The backend additionally enforces instance scope server-side; this client
 *   re-checks the returned instance id as defense-in-depth and refuses a
 *   response for any other instance.
 */
import { CrossInstanceError, type BackendOperationsClient, type OperationStatusUpdate, type PendingOperation } from '@shm/core';

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

interface ApiEnvelope<T> {
  status?: number;
  error?: string | null;
  data?: T | null;
}

interface PendingOperationDto {
  operation_id: string;
  instance_id: string;
  target_version: string;
  preflight_id: string;
  approval_token: string;
  approved_by_user_id: number;
  accepted_migration_risk: boolean;
  destructive_migration: boolean;
}

export interface HttpBackendOperationsClientOptions {
  /** Internal base URL of this instance's backend (no trailing slash needed). */
  backendBaseUrl: string;
  /** Per-instance manager bearer token. */
  managerToken: string;
  /** Server-derived trusted instance id this client is bound to. */
  instanceId: string;
  fetchImpl?: FetchImpl;
}

const PENDING_PATH = '/cms-api/v1/manager/system/update/pending';

export class HttpBackendOperationsClient implements BackendOperationsClient {
  private readonly base: string;
  private readonly token: string;
  private readonly instanceId: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: HttpBackendOperationsClientOptions) {
    this.base = opts.backendBaseUrl.replace(/\/+$/, '');
    this.token = opts.managerToken;
    this.instanceId = opts.instanceId;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'X-SelfHelp-Instance': this.instanceId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async fetchPending(instanceId: string): Promise<PendingOperation | null> {
    if (instanceId !== this.instanceId) {
      throw new CrossInstanceError({
        at: new Date().toISOString(),
        actorUserId: 0,
        requestedInstanceId: instanceId,
        trustedInstanceId: this.instanceId,
        allowed: false,
        reason: `Operations client is bound to "${this.instanceId}", refused fetch for "${instanceId}".`,
      });
    }

    const res = await this.fetchImpl(`${this.base}${PENDING_PATH}`, { method: 'GET', headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Backend returned HTTP ${res.status} for pending operations.`);

    const body = (await res.json()) as ApiEnvelope<PendingOperationDto>;
    const dto = body.data ?? null;
    if (dto === null || dto === undefined || dto.operation_id === undefined) return null;

    if (dto.instance_id !== this.instanceId) {
      throw new CrossInstanceError({
        at: new Date().toISOString(),
        actorUserId: dto.approved_by_user_id,
        requestedInstanceId: dto.instance_id,
        trustedInstanceId: this.instanceId,
        allowed: false,
        reason: `Backend returned an operation for "${dto.instance_id}", not this instance "${this.instanceId}".`,
      });
    }

    return {
      operationId: dto.operation_id,
      instanceId: dto.instance_id,
      targetVersion: dto.target_version,
      preflightId: dto.preflight_id,
      approvalToken: dto.approval_token,
      approvedByUserId: dto.approved_by_user_id,
      acceptedMigrationRisk: dto.accepted_migration_risk,
      destructiveMigration: dto.destructive_migration,
    };
  }

  async postStatus(update: OperationStatusUpdate): Promise<void> {
    const url = `${this.base}/cms-api/v1/manager/system/update/${encodeURIComponent(update.operationId)}/status`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        status: update.status,
        progress_percent: update.progressPercent,
        ...(update.message !== undefined ? { message: update.message } : {}),
        ...(update.steps !== undefined ? { steps: update.steps } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Backend rejected status write-back for ${update.operationId}: HTTP ${res.status}.`);
    }
  }
}
