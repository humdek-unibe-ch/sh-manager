// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Typed client for the manager BFF JSON API (see `apps/web/src/server.ts`).
 *
 * - One method per endpoint, all returning typed results.
 * - CSRF tokens (persistent mode) are captured on login, recovered from
 *   `/api/state` after a page reload, and replayed on every state-changing
 *   request automatically.
 * - Failures throw {@link ApiError} carrying the HTTP status and the server's
 *   human message — never a stack trace. Callers turn these into friendly UI.
 * - `fetch` is injectable so the client is unit-testable without a network.
 */
import type {
  BackupSummary,
  CloneInstanceRequest,
  CreateInstanceRequest,
  InstanceDetail,
  InstanceSummary,
  LoginResult,
  ManagerUpdateCheck,
  OperationRecord,
  RegistryVersions,
  RemoveInstanceRequest,
  SetAddressRequest,
  Snapshot,
  UpdateInstanceRequest,
  WizardConfig,
  WizardStepId,
} from './types';

/** Health report returned by POST /api/instances/:id/health (mirrors @shm/core). */
export interface InstanceHealthReport {
  instanceId: string;
  overall: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  services: { service: string; state: string; required: boolean; detail?: string }[];
  checkedAt: string;
}

/** 202 envelope returned by every mutating instance endpoint. */
export interface StartedOperation {
  operationId: string;
}

/** Pre-auth sign-in metadata (GET /api/auth/meta, persistent mode). */
export interface AuthMeta {
  mode: 'bootstrap' | 'persistent';
  /** False while no enabled local operator exists (first-run). */
  operatorsConfigured: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export interface ApiClient {
  getState(): Promise<Snapshot>;
  setConfig(patch: Partial<WizardConfig>): Promise<Snapshot>;
  advance(): Promise<Snapshot>;
  back(): Promise<Snapshot>;
  runCheck(step: WizardStepId): Promise<Snapshot>;
  install(): Promise<Snapshot>;
  managerUpdateCheck(): Promise<ManagerUpdateCheck>;
  /** Installable release versions for the wizard's version dropdown. */
  listVersions(channel?: string): Promise<RegistryVersions>;
  /** Pre-auth sign-in metadata (works without a session). */
  getAuthMeta(): Promise<AuthMeta>;
  login(email: string, password: string): Promise<LoginResult>;
  logout(): Promise<void>;

  // Instance management (persistent mode only; 404 in bootstrap mode).
  listInstances(): Promise<InstanceSummary[]>;
  getInstance(instanceId: string): Promise<InstanceDetail>;
  listBackups(instanceId: string): Promise<BackupSummary[]>;
  runInstanceHealth(instanceId: string): Promise<InstanceHealthReport>;
  updateDryRun(instanceId: string, req: UpdateInstanceRequest): Promise<{ plan: unknown }>;
  listOperations(instanceId?: string): Promise<OperationRecord[]>;
  getOperation(operationId: string): Promise<OperationRecord>;
  createInstance(req: CreateInstanceRequest): Promise<StartedOperation>;
  executeUpdate(instanceId: string, req: UpdateInstanceRequest): Promise<StartedOperation>;
  createBackup(instanceId: string): Promise<StartedOperation>;
  restoreBackup(instanceId: string, backupId: string): Promise<StartedOperation>;
  cloneInstance(instanceId: string, req: CloneInstanceRequest): Promise<StartedOperation>;
  /** Change the routed domain / local port; the instance restarts automatically. */
  setInstanceAddress(instanceId: string, req: SetAddressRequest): Promise<StartedOperation>;
  removeInstance(instanceId: string, req: RemoveInstanceRequest): Promise<StartedOperation>;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '';
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let csrfToken: string | null = null;

  async function request<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken && method !== 'GET') headers['x-shm-csrf'] = csrfToken;

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, 'Could not reach the manager service. Check that it is still running.');
    }

    const data = parseJson(await res.text());
    if (!res.ok) {
      const message =
        (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
          ? (data as { error: string }).error
          : null) ?? `Request failed (${res.status}).`;
      throw new ApiError(res.status, message);
    }
    return data as T;
  }

  return {
    async getState() {
      const snapshot = await request<Snapshot>('/api/state', 'GET');
      // Recover the CSRF token after a page reload: the session cookie
      // survives, the in-memory token does not. Without this every later
      // POST (sign out, checks, installs) failed with 403.
      if (snapshot.session?.csrfToken) csrfToken = snapshot.session.csrfToken;
      return snapshot;
    },
    setConfig: (patch) => request<Snapshot>('/api/config', 'POST', patch),
    advance: () => request<Snapshot>('/api/advance', 'POST'),
    back: () => request<Snapshot>('/api/back', 'POST'),
    runCheck: (step) => request<Snapshot>(`/api/check/${step}`, 'POST'),
    install: () => request<Snapshot>('/api/install', 'POST'),
    managerUpdateCheck: () => request<ManagerUpdateCheck>('/api/manager/update-check', 'GET'),
    listVersions: (channel) =>
      request<RegistryVersions>(
        `/api/registry/versions${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`,
        'GET',
      ),
    getAuthMeta: () => request<AuthMeta>('/api/auth/meta', 'GET'),
    async login(email, password) {
      const result = await request<LoginResult>('/api/login', 'POST', { email, password });
      csrfToken = result.csrfToken;
      return result;
    },
    async logout() {
      await request<{ ok: boolean }>('/api/logout', 'POST');
      csrfToken = null;
    },

    listInstances: async () =>
      (await request<{ instances: InstanceSummary[] }>('/api/instances', 'GET')).instances,
    getInstance: (instanceId) => request<InstanceDetail>(`/api/instances/${encodeURIComponent(instanceId)}`, 'GET'),
    listBackups: async (instanceId) =>
      (await request<{ backups: BackupSummary[] }>(`/api/instances/${encodeURIComponent(instanceId)}/backups`, 'GET'))
        .backups,
    runInstanceHealth: (instanceId) =>
      request<InstanceHealthReport>(`/api/instances/${encodeURIComponent(instanceId)}/health`, 'POST'),
    updateDryRun: (instanceId, req) =>
      request<{ plan: unknown }>(`/api/instances/${encodeURIComponent(instanceId)}/update/dry-run`, 'POST', req),
    listOperations: async (instanceId) =>
      (
        await request<{ operations: OperationRecord[] }>(
          `/api/operations${instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : ''}`,
          'GET',
        )
      ).operations,
    getOperation: (operationId) => request<OperationRecord>(`/api/operations/${encodeURIComponent(operationId)}`, 'GET'),
    createInstance: (req) => request<StartedOperation>('/api/instances', 'POST', req),
    executeUpdate: (instanceId, req) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/update`, 'POST', req),
    createBackup: (instanceId) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/backups`, 'POST'),
    restoreBackup: (instanceId, backupId) =>
      request<StartedOperation>(
        `/api/instances/${encodeURIComponent(instanceId)}/backups/${encodeURIComponent(backupId)}/restore`,
        'POST',
      ),
    cloneInstance: (instanceId, req) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/clone`, 'POST', req),
    setInstanceAddress: (instanceId, req) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/address`, 'POST', req),
    removeInstance: (instanceId, req) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/remove`, 'POST', req),
  };
}
