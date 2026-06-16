// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Typed client for the manager BFF JSON API (see `apps/web/src/server.ts`).
 *
 * - One method per endpoint, all returning typed results.
 * - CSRF tokens are captured on login/setup, recovered from `/api/state`
 *   after a page reload, and replayed on every state-changing request
 *   automatically.
 * - Failures throw {@link ApiError} carrying the HTTP status and the server's
 *   human message — never a stack trace. Callers turn these into friendly UI.
 * - `fetch` is injectable so the client is unit-testable without a network.
 */
import type {
  BackupSchedulePolicy,
  BackupScheduleStatus,
  BackupSummary,
  CloneInstanceRequest,
  CreateInstanceRequest,
  FrontendUpdateInstanceRequest,
  InstalledPluginInfo,
  InstanceDetail,
  InstanceEnvConfig,
  InstanceLogsResult,
  InstanceSummary,
  LoginResult,
  LogService,
  MailerStatus,
  ManagerUpdateCheck,
  OperationRecord,
  PreflightResult,
  PruneExecutionReport,
  RegistryVersions,
  RemoveInstanceRequest,
  ServerStatus,
  SetAddressRequest,
  SetEnvRequest,
  SetMailerRequest,
  SetNameRequest,
  Snapshot,
  UpdateInstanceRequest,
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

/** Pre-auth sign-in metadata (GET /api/auth/meta). */
export interface AuthMeta {
  mode: 'persistent';
  /** False while no enabled local operator exists (first-run). */
  operatorsConfigured: boolean;
  managerVersion?: string;
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
  managerUpdateCheck(): Promise<ManagerUpdateCheck>;
  /**
   * Installable release versions for a version dropdown. `kind` selects the
   * registry feed: `core` (install/update target, default) or `frontend` (the
   * independently-released frontend used by the frontend-only update dialog).
   */
  listVersions(channel?: string, kind?: 'core' | 'frontend'): Promise<RegistryVersions>;
  /** Pre-auth sign-in metadata (works without a session). */
  getAuthMeta(): Promise<AuthMeta>;
  login(email: string, password: string): Promise<LoginResult>;
  /** First-run only: create the FIRST operator account and sign in. */
  setupOperator(email: string, password: string, displayName?: string): Promise<LoginResult>;
  logout(): Promise<void>;

  // Server-level views used by the create wizard.
  getServerStatus(): Promise<ServerStatus>;
  runPreflight(req: { mode?: 'production' | 'local' }): Promise<PreflightResult>;

  // Instance management.
  listInstances(): Promise<InstanceSummary[]>;
  getInstance(instanceId: string): Promise<InstanceDetail>;
  listBackups(instanceId: string): Promise<BackupSummary[]>;
  /**
   * Plugins ACTUALLY installed in the running instance (live DB read), or null
   * when the instance is down/unreachable (caller falls back to the manifest).
   */
  listInstancePlugins(instanceId: string): Promise<InstalledPluginInfo[] | null>;
  /** Schedule policy + run state + footprint estimate. */
  getBackupSchedule(instanceId: string): Promise<BackupScheduleStatus>;
  /** Persist the (complete) schedule policy; the server validates it. */
  setBackupSchedule(instanceId: string, policy: BackupSchedulePolicy): Promise<BackupScheduleStatus>;
  /** Read-only retention preview: what would be kept/deleted, deletes nothing. */
  previewBackupPrune(instanceId: string): Promise<PruneExecutionReport>;
  /** Apply the retention policy now (journaled operation). */
  pruneBackups(instanceId: string): Promise<StartedOperation>;
  runInstanceHealth(instanceId: string): Promise<InstanceHealthReport>;
  getMailer(instanceId: string): Promise<MailerStatus>;
  /** Effective non-secret environment of an instance (read-only). */
  getInstanceEnv(instanceId: string): Promise<InstanceEnvConfig>;
  /** Recent (redacted) container logs for one service of an instance. */
  getInstanceLogs(instanceId: string, service: LogService, tail?: number): Promise<InstanceLogsResult>;
  updateDryRun(instanceId: string, req: UpdateInstanceRequest): Promise<{ plan: unknown }>;
  /** Plan-only frontend-only update preview (never mutates). */
  frontendUpdateDryRun(instanceId: string, req: FrontendUpdateInstanceRequest): Promise<{ plan: unknown }>;
  listOperations(instanceId?: string): Promise<OperationRecord[]>;
  getOperation(operationId: string): Promise<OperationRecord>;
  createInstance(req: CreateInstanceRequest): Promise<StartedOperation>;
  executeUpdate(instanceId: string, req: UpdateInstanceRequest): Promise<StartedOperation>;
  /** Update ONLY the frontend (stateless swap; core + data untouched). */
  executeFrontendUpdate(instanceId: string, req: FrontendUpdateInstanceRequest): Promise<StartedOperation>;
  createBackup(instanceId: string): Promise<StartedOperation>;
  restoreBackup(instanceId: string, backupId: string): Promise<StartedOperation>;
  cloneInstance(instanceId: string, req: CloneInstanceRequest): Promise<StartedOperation>;
  /** Change the routed domain / local port; the instance restarts automatically. */
  setInstanceAddress(instanceId: string, req: SetAddressRequest): Promise<StartedOperation>;
  /** Set or clear the outbound-mail DSN; the instance restarts automatically. */
  setMailer(instanceId: string, req: SetMailerRequest): Promise<StartedOperation>;
  /** Rename the instance's display name only (metadata; no restart). */
  setInstanceName(instanceId: string, req: SetNameRequest): Promise<StartedOperation>;
  /** Persist non-secret env overrides; the instance restarts automatically. */
  setInstanceEnv(instanceId: string, req: SetEnvRequest): Promise<StartedOperation>;
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

  async function request<T>(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<T> {
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
      // POST (sign out, installs) failed with 403.
      if (snapshot.session?.csrfToken) csrfToken = snapshot.session.csrfToken;
      return snapshot;
    },
    managerUpdateCheck: () => request<ManagerUpdateCheck>('/api/manager/update-check', 'GET'),
    listVersions: (channel, kind) => {
      const params = new URLSearchParams();
      if (channel) params.set('channel', channel);
      if (kind) params.set('kind', kind);
      const qs = params.toString();
      return request<RegistryVersions>(`/api/registry/versions${qs ? `?${qs}` : ''}`, 'GET');
    },
    getAuthMeta: () => request<AuthMeta>('/api/auth/meta', 'GET'),
    async login(email, password) {
      const result = await request<LoginResult>('/api/login', 'POST', { email, password });
      csrfToken = result.csrfToken;
      return result;
    },
    async setupOperator(email, password, displayName) {
      const result = await request<LoginResult>('/api/setup/operator', 'POST', {
        email,
        password,
        ...(displayName ? { displayName } : {}),
      });
      csrfToken = result.csrfToken;
      return result;
    },
    async logout() {
      await request<{ ok: boolean }>('/api/logout', 'POST');
      csrfToken = null;
    },

    getServerStatus: () => request<ServerStatus>('/api/server/status', 'GET'),
    runPreflight: (req) => request<PreflightResult>('/api/server/preflight', 'POST', req),

    listInstances: async () =>
      (await request<{ instances: InstanceSummary[] }>('/api/instances', 'GET')).instances,
    getInstance: (instanceId) => request<InstanceDetail>(`/api/instances/${encodeURIComponent(instanceId)}`, 'GET'),
    listBackups: async (instanceId) =>
      (await request<{ backups: BackupSummary[] }>(`/api/instances/${encodeURIComponent(instanceId)}/backups`, 'GET'))
        .backups,
    listInstancePlugins: async (instanceId) =>
      (
        await request<{ plugins: InstalledPluginInfo[] | null }>(
          `/api/instances/${encodeURIComponent(instanceId)}/plugins`,
          'GET',
        )
      ).plugins,
    getBackupSchedule: (instanceId) =>
      request<BackupScheduleStatus>(`/api/instances/${encodeURIComponent(instanceId)}/backup-schedule`, 'GET'),
    setBackupSchedule: (instanceId, policy) =>
      request<BackupScheduleStatus>(`/api/instances/${encodeURIComponent(instanceId)}/backup-schedule`, 'PUT', policy),
    previewBackupPrune: (instanceId) =>
      request<PruneExecutionReport>(`/api/instances/${encodeURIComponent(instanceId)}/backup-prune`, 'POST', { dryRun: true }),
    pruneBackups: (instanceId) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/backup-prune`, 'POST', {}),
    runInstanceHealth: (instanceId) =>
      request<InstanceHealthReport>(`/api/instances/${encodeURIComponent(instanceId)}/health`, 'POST'),
    getMailer: (instanceId) => request<MailerStatus>(`/api/instances/${encodeURIComponent(instanceId)}/mailer`, 'GET'),
    getInstanceEnv: (instanceId) =>
      request<InstanceEnvConfig>(`/api/instances/${encodeURIComponent(instanceId)}/env`, 'GET'),
    getInstanceLogs: (instanceId, service, tail) => {
      const params = new URLSearchParams({ service });
      if (tail !== undefined) params.set('tail', String(tail));
      return request<InstanceLogsResult>(
        `/api/instances/${encodeURIComponent(instanceId)}/logs?${params.toString()}`,
        'GET',
      );
    },
    updateDryRun: (instanceId, req) =>
      request<{ plan: unknown }>(`/api/instances/${encodeURIComponent(instanceId)}/update/dry-run`, 'POST', req),
    frontendUpdateDryRun: (instanceId, req) =>
      request<{ plan: unknown }>(`/api/instances/${encodeURIComponent(instanceId)}/frontend-update/dry-run`, 'POST', req),
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
    executeFrontendUpdate: (instanceId, req) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/frontend-update`, 'POST', req),
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
    setMailer: (instanceId, req) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/mailer`, 'POST', req),
    setInstanceName: (instanceId, req) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/name`, 'POST', req),
    setInstanceEnv: (instanceId, req) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/env`, 'POST', req),
    removeInstance: (instanceId, req) =>
      request<StartedOperation>(`/api/instances/${encodeURIComponent(instanceId)}/remove`, 'POST', req),
  };
}
