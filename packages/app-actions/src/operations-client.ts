// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Transports between the manager and ONE instance's backend for the
 * CMS<->Manager update loop. Two implementations of the same
 * {@link BackendOperationsClient} contract:
 *
 * - {@link HttpBackendOperationsClient} — direct HTTP to a reachable backend
 *   base URL with a host-side bearer token (advanced/remote setups, e2e).
 * - {@link ComposeExecBackendOperationsClient} — the production default:
 *   `docker compose exec -T backend php -r …` performs the HTTP call FROM
 *   INSIDE the backend container against its own localhost, using the
 *   container's own `SELFHELP_MANAGER_TOKEN` env. No published backend port,
 *   no host-side token handling, works wherever the manager has Docker.
 *
 * Security model (both transports):
 * - The client is bound to a single instance id + that instance's per-instance
 *   manager token (a bearer secret). It never carries a shared/global
 *   credential, so it cannot read or write another instance's operations.
 * - The backend additionally enforces instance scope server-side; this client
 *   re-checks the returned instance id as defense-in-depth and refuses a
 *   response for any other instance.
 */
import type { ComposeRunner } from '@shm/docker';
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
  /** Optional. `core` (default, back-compat) or `frontend` (lightweight swap). */
  kind?: 'core' | 'frontend';
  /** Optional. The frontend version a `frontend`-kind operation targets (null for core). */
  target_frontend_version?: string | null;
}

const PENDING_PATH = '/cms-api/v1/manager/system/update/pending';

function statusPath(operationId: string): string {
  return `/cms-api/v1/manager/system/update/${encodeURIComponent(operationId)}/status`;
}

function statusBody(update: OperationStatusUpdate): string {
  return JSON.stringify({
    status: update.status,
    progress_percent: update.progressPercent,
    ...(update.message !== undefined ? { message: update.message } : {}),
    ...(update.steps !== undefined ? { steps: update.steps } : {}),
  });
}

/** Shared DTO -> domain mapping + instance-scope re-check for both transports. */
function toPendingOperation(dto: PendingOperationDto | null, trustedInstanceId: string): PendingOperation | null {
  if (dto === null || dto === undefined || dto.operation_id === undefined) return null;

  if (dto.instance_id !== trustedInstanceId) {
    throw new CrossInstanceError({
      at: new Date().toISOString(),
      actorUserId: dto.approved_by_user_id,
      requestedInstanceId: dto.instance_id,
      trustedInstanceId,
      allowed: false,
      reason: `Backend returned an operation for "${dto.instance_id}", not this instance "${trustedInstanceId}".`,
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
    // A backend that omits `kind` is treated as a `core` update (back-compat).
    kind: dto.kind === 'frontend' ? 'frontend' : 'core',
    // Only carry a frontend target when the backend actually sent one (core
    // operations send null/omit it — the manager resolves the frontend itself).
    ...(typeof dto.target_frontend_version === 'string'
      ? { targetFrontendVersion: dto.target_frontend_version }
      : {}),
  };
}

function assertBoundInstance(requested: string, bound: string): void {
  if (requested !== bound) {
    throw new CrossInstanceError({
      at: new Date().toISOString(),
      actorUserId: 0,
      requestedInstanceId: requested,
      trustedInstanceId: bound,
      allowed: false,
      reason: `Operations client is bound to "${bound}", refused fetch for "${requested}".`,
    });
  }
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
    assertBoundInstance(instanceId, this.instanceId);

    const res = await this.fetchImpl(`${this.base}${PENDING_PATH}`, { method: 'GET', headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Backend returned HTTP ${res.status} for pending operations.`);

    const body = (await res.json()) as ApiEnvelope<PendingOperationDto>;
    return toPendingOperation(body.data ?? null, this.instanceId);
  }

  async postStatus(update: OperationStatusUpdate): Promise<void> {
    const res = await this.fetchImpl(`${this.base}${statusPath(update.operationId)}`, {
      method: 'POST',
      headers: this.headers(),
      body: statusBody(update),
    });
    if (!res.ok) {
      throw new Error(`Backend rejected status write-back for ${update.operationId}: HTTP ${res.status}.`);
    }
  }
}

/** Backend HTTP port inside the container (see @shm/docker BACKEND_INTERNAL_PORT). */
const EXEC_BACKEND_PORT = 8080;

/**
 * PHP one-liner executed inside the backend container. Reads method/path/body
 * from argv (never interpolated into code), the bearer token from the
 * container's own SELFHELP_MANAGER_TOKEN env, performs the HTTP request
 * against localhost, and prints `<status>\n<body>` for the host to parse.
 * `ignore_errors` keeps non-2xx responses readable instead of failing the exec.
 */
const EXEC_PHP_SCRIPT = [
  '$m=$argv[1];$p=$argv[2];$b=$argv[3]??null;',
  "$t=getenv('SELFHELP_MANAGER_TOKEN')?:'';",
  "$h=\"Authorization: Bearer $t\\r\\nAccept: application/json\\r\\nContent-Type: application/json\\r\\n\";",
  "$c=stream_context_create(['http'=>['method'=>$m,'header'=>$h,'content'=>$b??'','ignore_errors'=>true,'timeout'=>30]]);",
  `$r=@file_get_contents('http://127.0.0.1:${EXEC_BACKEND_PORT}'.$p,false,$c);`,
  '$s=0;foreach($http_response_header??[] as $l){if(preg_match("#^HTTP/\\\\S+\\\\s+(\\\\d{3})#",$l,$mm)){$s=(int)$mm[1];}}',
  'echo $s,"\\n",$r===false?"":$r;',
].join('');

export interface ComposeExecBackendOperationsClientOptions {
  /** Compose runner used to `exec` into the instance's backend container. */
  runner: ComposeRunner;
  /** Instance directory containing the compose project. */
  instanceDir: string;
  /** Server-derived trusted instance id this client is bound to. */
  instanceId: string;
}

/**
 * Production-default transport: performs the update-loop HTTP calls from
 * inside the instance's backend container. Requires only what the manager
 * already has (the Docker socket); the token never crosses the host boundary.
 */
export class ComposeExecBackendOperationsClient implements BackendOperationsClient {
  private readonly runner: ComposeRunner;
  private readonly instanceDir: string;
  private readonly instanceId: string;

  constructor(opts: ComposeExecBackendOperationsClientOptions) {
    this.runner = opts.runner;
    this.instanceDir = opts.instanceDir;
    this.instanceId = opts.instanceId;
  }

  private async request(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
    const args = ['exec', '-T', 'backend', 'php', '-r', EXEC_PHP_SCRIPT, '--', method, path];
    if (body !== undefined) args.push(body);
    const { stdout } = await this.runner.run(this.instanceDir, args);
    const newline = stdout.indexOf('\n');
    const statusLine = newline >= 0 ? stdout.slice(0, newline) : stdout;
    const status = parseInt(statusLine.trim(), 10);
    if (!Number.isFinite(status) || status === 0) {
      throw new Error(
        `Backend did not answer the manager loop inside the container (is the backend running and ` +
          `SELFHELP_MANAGER_TOKEN set in its environment?). Raw response: ${stdout.slice(0, 200)}`,
      );
    }
    return { status, body: newline >= 0 ? stdout.slice(newline + 1) : '' };
  }

  async fetchPending(instanceId: string): Promise<PendingOperation | null> {
    assertBoundInstance(instanceId, this.instanceId);

    const res = await this.request('GET', PENDING_PATH);
    if (res.status === 404) return null;
    if (res.status === 401) {
      throw new Error(
        'Backend rejected the manager token (HTTP 401). The instance may predate the manager token — ' +
          'run an update or `sh-manager instance repair <id>` to backfill it, then recreate the containers.',
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Backend returned HTTP ${res.status} for pending operations.`);
    }

    let body: ApiEnvelope<PendingOperationDto>;
    try {
      body = JSON.parse(res.body) as ApiEnvelope<PendingOperationDto>;
    } catch {
      throw new Error(`Backend returned a non-JSON pending-operations response: ${res.body.slice(0, 200)}`);
    }
    return toPendingOperation(body.data ?? null, this.instanceId);
  }

  async postStatus(update: OperationStatusUpdate): Promise<void> {
    const res = await this.request('POST', statusPath(update.operationId), statusBody(update));
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Backend rejected status write-back for ${update.operationId}: HTTP ${res.status}.`);
    }
  }
}
