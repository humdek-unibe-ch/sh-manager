// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * In-memory ApiClient for UI tests. Mutating instance calls run the REAL
 * shared validation (`src/instance-validation.ts`) — the same rules the
 * production BFF enforces — so component/flow tests can never pass a request
 * the server would reject.
 */
import { validateSchedulePolicy } from '@shm/backup';
import { MANAGER_CONTROLLED_ENV_KEYS } from '@shm/docker';
import { validateAddressChange, validateCloneInstance, validateCreateInstance } from '../../instance-validation';
import { ApiError, type ApiClient, type InstanceHealthReport } from '../lib/api-client';
import type {
  BackupScheduleStatus,
  BackupSummary,
  CheckResult,
  InstanceDetail,
  InstanceEnvConfig,
  InstanceSummary,
  MailerStatus,
  OperationRecord,
  PreflightResult,
  PruneExecutionReport,
  ServerStatus,
  Snapshot,
} from '../lib/types';

export interface FakeClientOptions {
  /** Simulate a newer published manager release. */
  managerUpdateAvailable?: boolean;
  /** Versions returned by listVersions (default: a small fixed set). */
  availableVersions?: string[];
  /** Instance inventory served by the instance APIs (default: one active instance). */
  instances?: InstanceSummary[];
  /** Backups per instance id. */
  backups?: Record<string, BackupSummary[]>;
  /** Pre-seeded operation journal records. */
  operations?: OperationRecord[];
  /** Plan returned by updateDryRun (shape mirrors @shm/core UpdatePlan). */
  dryRunPlan?: unknown;
  /** Plan returned by frontendUpdateDryRun (shape mirrors @shm/core FrontendUpdatePlan). */
  frontendDryRunPlan?: unknown;
  /** When set, every mutating instance call rejects with this ApiError. */
  failMutations?: ApiError;
  /** getAuthMeta().operatorsConfigured (default true; false = first-run setup). */
  operatorsConfigured?: boolean;
  /** getServerStatus().initialized (default true; false = first install bootstraps the server). */
  serverInitialized?: boolean;
  /** Per-check preflight overrides (default: everything ok). */
  preflight?: Partial<Record<'docker' | 'internet' | 'registry' | 'resources', CheckResult>>;
  /** Mailer status per instance id (default: not configured). */
  mailers?: Record<string, MailerStatus>;
  /** Effective env per instance id (default: a small representative set). */
  envConfigs?: Record<string, InstanceEnvConfig>;
  /** Backup schedule status per instance id (default: nothing configured). */
  backupSchedules?: Record<string, BackupScheduleStatus>;
  /** Retention preview served by previewBackupPrune (default: keep everything). */
  prunePreview?: PruneExecutionReport;
}

export function fakeInstance(overrides: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    instanceId: 'clinic-a',
    displayName: 'Clinic A',
    domain: 'clinic-a.example',
    mode: 'production',
    status: 'active',
    version: '0.1.0',
    updatedAt: '2026-06-01T10:00:00.000Z',
    brokenReason: null,
    busy: null,
    ...overrides,
  };
}

export function fakeBackup(overrides: Partial<BackupSummary> = {}): BackupSummary {
  return {
    backupId: 'bk-20260601-1000',
    createdAt: '2026-06-01T10:00:00.000Z',
    origin: 'manual',
    selfhelpVersion: '0.1.0',
    migrationVersion: 'Version20260501000400',
    includedAreas: ['db', 'uploads', 'config'],
    pluginCount: 1,
    totalBytes: 12_582_912,
    backupDir: '/opt/selfhelp/instances/clinic-a/backups/bk-20260601-1000',
    ...overrides,
  };
}

export function fakeOperation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: 'op-1',
    kind: 'instance_backup',
    instanceId: 'clinic-a',
    status: 'succeeded',
    phase: 'backup',
    startedAt: '2026-06-01T10:00:00.000Z',
    finishedAt: '2026-06-01T10:01:00.000Z',
    log: ['Backup bk-20260601-1000 written.'],
    result: { backupId: 'bk-20260601-1000' },
    error: null,
    ...overrides,
  };
}

export function fakeScheduleStatus(overrides: Partial<BackupScheduleStatus> = {}): BackupScheduleStatus {
  return {
    instanceId: 'clinic-a',
    policy: { enabled: true, time: '02:00', retention: { daily: 7, weekly: 5, monthly: 12, maxAgeDays: 365 } },
    lastRunAt: '2026-06-01T02:00:05.000Z',
    lastResult: 'succeeded',
    lastBackupId: 'backup-20260601-clinic-a-001',
    lastDetail: null,
    nextRunAt: '2026-06-02T02:00:00.000Z',
    backups: { count: 3, totalBytes: 37_748_736 },
    footprint: { slots: 24, averageBackupBytes: 12_582_912, steadyStateBytes: 301_989_888, requiredFreeBytes: 25_165_824 },
    ...overrides,
  };
}

/** Representative effective env for an instance (editable + managed keys). */
export function fakeEnvConfig(instanceId = 'clinic-a'): InstanceEnvConfig {
  return {
    instanceId,
    managedKeys: [...MANAGER_CONTROLLED_ENV_KEYS],
    entries: [
      { key: 'APP_DEBUG', value: '0', defaultValue: '0', managed: false, custom: false, overridden: false },
      {
        key: 'FRONTEND_BASE_URL',
        value: 'https://clinic-a.example',
        defaultValue: 'https://clinic-a.example',
        managed: false,
        custom: false,
        overridden: false,
      },
      { key: 'JWT_TOKEN_TTL', value: '3600', defaultValue: '3600', managed: false, custom: false, overridden: false },
      {
        key: 'SELFHELP_INSTANCE_ID',
        value: instanceId,
        defaultValue: instanceId,
        managed: true,
        custom: false,
        overridden: false,
      },
      {
        key: 'SYMFONY_INTERNAL_URL',
        value: 'http://backend:8080',
        defaultValue: 'http://backend:8080',
        managed: true,
        custom: false,
        overridden: false,
      },
    ],
  };
}

/** Default dry-run plan (mirrors the @shm/core UpdatePlan fields the UI reads). */
export const FAKE_DRY_RUN_PLAN = {
  instanceId: 'clinic-a',
  currentVersion: '0.1.0',
  targetVersion: '0.2.0',
  status: 'ok',
  core: { id: 'selfhelp-core', version: '0.2.0' },
  frontend: { id: 'selfhelp-frontend', version: '0.2.0' },
  reasons: [],
  pluginEvaluations: [],
  preflight: null,
  steps: ['backup', 'pull images', 'recreate containers', 'run migrations', 'health check'],
};

/** Default frontend-only dry-run plan (mirrors @shm/core FrontendUpdatePlan). */
export const FAKE_FRONTEND_DRY_RUN_PLAN = {
  instanceId: 'clinic-a',
  kind: 'frontend',
  currentFrontendVersion: '0.1.5',
  targetFrontendVersion: '0.1.7',
  status: 'ok',
  frontend: { id: 'selfhelp-frontend-0.1.7', version: '0.1.7' },
  reasons: [],
  steps: ['snapshot config', 'pull frontend image (0.1.7)', 'recreate frontend container', 'health check'],
};

/** Manager version baked into every fake snapshot (asserted by header tests). */
export const FAKE_MANAGER_VERSION = '1.0.6-test';

/** Registry URL the fake preflight reports (mirrors the BFF default). */
export const FAKE_REGISTRY_URL = 'https://registry.example.com/';

const OK: CheckResult = { ok: true, severity: 'ok', detail: 'OK.' };

export function makeFakeClient(opts: FakeClientOptions = {}): ApiClient {
  // In-memory instance/operation store for the console tests.
  const instances: InstanceSummary[] = opts.instances ?? [fakeInstance()];
  const backups: Record<string, BackupSummary[]> = opts.backups ?? { 'clinic-a': [fakeBackup()] };
  const operations: OperationRecord[] = [...(opts.operations ?? [])];
  const mailers: Record<string, MailerStatus> = { ...(opts.mailers ?? {}) };
  const envConfigs: Record<string, InstanceEnvConfig> = { ...(opts.envConfigs ?? {}) };
  const schedules: Record<string, BackupScheduleStatus> = { ...(opts.backupSchedules ?? {}) };
  let opCounter = operations.length;
  let operatorsConfigured = opts.operatorsConfigured ?? true;
  let signedIn = false;

  function startFakeOperation(kind: OperationRecord['kind'], instanceId: string | null): { operationId: string } {
    if (opts.failMutations) throw opts.failMutations;
    opCounter += 1;
    const id = `op-${opCounter}`;
    operations.unshift(
      fakeOperation({
        id,
        kind,
        instanceId,
        status: 'succeeded',
        phase: 'done',
        log: [`${kind} finished.`],
        result: { ok: true },
      }),
    );
    return { operationId: id };
  }

  return {
    async getState(): Promise<Snapshot> {
      return {
        mode: 'persistent',
        managerVersion: FAKE_MANAGER_VERSION,
        ...(signedIn
          ? { session: { email: 'owner@example.com', roles: ['server_owner'], csrfToken: 'csrf-token' } }
          : {}),
      };
    },
    async listVersions() {
      return { versions: opts.availableVersions ?? ['0.3.0', '0.2.1', '0.2.0'] };
    },
    async managerUpdateCheck() {
      return opts.managerUpdateAvailable
        ? {
            currentVersion: '0.1.4',
            latestVersion: '0.2.0',
            updateAvailable: true,
            runtime: 'docker' as const,
            releaseUrl: 'https://github.com/humdek-unibe-ch/sh-manager/releases/tag/v0.2.0',
            instructions: ['docker pull ghcr.io/humdek-unibe-ch/sh-manager:v0.2.0'],
          }
        : { currentVersion: '0.1.4', latestVersion: '0.1.4', updateAvailable: false, runtime: 'docker' as const, instructions: [] };
    },
    async getAuthMeta() {
      return { mode: 'persistent' as const, operatorsConfigured, managerVersion: FAKE_MANAGER_VERSION };
    },
    async login() {
      signedIn = true;
      return { ok: true, email: 'owner@example.com', roles: ['server_owner'], csrfToken: 'csrf-token' };
    },
    async setupOperator(email) {
      if (operatorsConfigured) throw new ApiError(409, 'Operators already exist. Sign in instead.');
      operatorsConfigured = true;
      signedIn = true;
      return { ok: true, email, roles: ['server_owner'], csrfToken: 'csrf-token' };
    },
    async logout() {
      signedIn = false;
    },

    async getServerStatus(): Promise<ServerStatus> {
      const initialized = opts.serverInitialized ?? true;
      return initialized
        ? { initialized: true, serverId: 'srv-1', proxyNetwork: 'selfhelp-proxy', instanceCount: instances.length }
        : { initialized: false, serverId: null, proxyNetwork: null, instanceCount: 0 };
    },
    async runPreflight(): Promise<PreflightResult> {
      return {
        docker: opts.preflight?.docker ?? OK,
        internet: opts.preflight?.internet ?? OK,
        registry: opts.preflight?.registry ?? OK,
        resources: opts.preflight?.resources ?? OK,
        registryUrl: FAKE_REGISTRY_URL,
      };
    },

    async listInstances() {
      return [...instances];
    },
    async getInstance(instanceId) {
      const summary = instances.find((i) => i.instanceId === instanceId);
      if (!summary) throw new ApiError(404, `Instance "${instanceId}" not found.`);
      const detail: InstanceDetail = {
        summary,
        manifest: null,
        instanceDir: `/opt/selfhelp/instances/${instanceId}`,
      };
      return detail;
    },
    async listBackups(instanceId) {
      return backups[instanceId] ?? [];
    },
    async getBackupSchedule(instanceId) {
      if (!instances.some((i) => i.instanceId === instanceId)) {
        throw new ApiError(404, `Instance "${instanceId}" not found.`);
      }
      return (
        schedules[instanceId] ??
        fakeScheduleStatus({
          instanceId,
          policy: null,
          lastRunAt: null,
          lastResult: null,
          lastBackupId: null,
          nextRunAt: null,
          backups: { count: (backups[instanceId] ?? []).length, totalBytes: 0 },
          footprint: { slots: 24, averageBackupBytes: 0, steadyStateBytes: 0, requiredFreeBytes: 0 },
        })
      );
    },
    async setBackupSchedule(instanceId, policy) {
      if (opts.failMutations) throw opts.failMutations;
      // Same validation the BFF route runs (@shm/backup validateSchedulePolicy).
      const problems = validateSchedulePolicy(policy);
      if (problems.length > 0) throw new ApiError(400, problems.join(' '));
      const status = fakeScheduleStatus({
        instanceId,
        policy,
        nextRunAt: policy.enabled ? '2026-06-02T02:00:00.000Z' : null,
      });
      schedules[instanceId] = status;
      return status;
    },
    async previewBackupPrune(instanceId) {
      return (
        opts.prunePreview ?? {
          plan: {
            keep: (backups[instanceId] ?? []).map((b) => ({
              backupId: b.backupId,
              origin: b.origin,
              createdAt: b.createdAt,
              action: 'keep' as const,
              reasons: ['manual' as const],
            })),
            prune: [],
          },
          deleted: [],
          skipped: [],
          dryRun: true,
        }
      );
    },
    async pruneBackups(instanceId) {
      return startFakeOperation('instance_backup_prune', instanceId);
    },
    async runInstanceHealth(instanceId): Promise<InstanceHealthReport> {
      return {
        instanceId,
        overall: 'healthy',
        services: [
          { service: 'backend', state: 'running', required: true },
          { service: 'db', state: 'running', required: true },
          { service: 'redis', state: 'running', required: false },
        ],
        checkedAt: '2026-06-01T12:00:00.000Z',
      };
    },
    async getMailer(instanceId): Promise<MailerStatus> {
      if (!instances.some((i) => i.instanceId === instanceId)) {
        throw new ApiError(404, `Instance "${instanceId}" not found.`);
      }
      return mailers[instanceId] ?? { configured: false };
    },
    async getInstanceEnv(instanceId): Promise<InstanceEnvConfig> {
      if (!instances.some((i) => i.instanceId === instanceId)) {
        throw new ApiError(404, `Instance "${instanceId}" not found.`);
      }
      return envConfigs[instanceId] ?? fakeEnvConfig(instanceId);
    },
    async updateDryRun() {
      return { plan: opts.dryRunPlan ?? FAKE_DRY_RUN_PLAN };
    },
    async frontendUpdateDryRun() {
      return { plan: opts.frontendDryRunPlan ?? FAKE_FRONTEND_DRY_RUN_PLAN };
    },
    async listOperations(instanceId) {
      return instanceId ? operations.filter((o) => o.instanceId === instanceId) : [...operations];
    },
    async getOperation(operationId) {
      const op = operations.find((o) => o.id === operationId);
      if (!op) throw new ApiError(404, 'Operation not found.');
      return op;
    },
    async createInstance(req) {
      // Same shared validation the BFF route runs (instance-validation.ts).
      const problems = validateCreateInstance(req);
      if (problems.length > 0) throw new ApiError(400, problems.join(' '));
      const started = startFakeOperation('instance_create', req.instanceId);
      instances.push(
        fakeInstance({
          instanceId: req.instanceId,
          displayName: req.displayName,
          domain: req.domain ?? `localhost:${req.localPort ?? 0}`,
          mode: req.mode,
        }),
      );
      if (req.mailerDsn) mailers[req.instanceId] = { configured: true, redactedDsn: 'smtp://***@configured' };
      return started;
    },
    async executeUpdate(instanceId) {
      return startFakeOperation('instance_update', instanceId);
    },
    async executeFrontendUpdate(instanceId) {
      return startFakeOperation('instance_frontend_update', instanceId);
    },
    async createBackup(instanceId) {
      return startFakeOperation('instance_backup', instanceId);
    },
    async restoreBackup(instanceId) {
      return startFakeOperation('instance_restore', instanceId);
    },
    async cloneInstance(instanceId, req) {
      const source = instances.find((i) => i.instanceId === instanceId);
      if (!source) throw new ApiError(404, `Instance "${instanceId}" not found.`);
      const problems = validateCloneInstance({
        sourceInstanceId: instanceId,
        sourceMode: source.mode === 'local' ? 'local' : 'production',
        sourceDomain: source.domain,
        ...(req.targetInstanceId ? { targetInstanceId: req.targetInstanceId } : {}),
        ...(req.targetDomain ? { targetDomain: req.targetDomain } : {}),
        ...(req.targetLocalPort !== undefined ? { targetLocalPort: req.targetLocalPort } : {}),
      });
      if (problems.length > 0) throw new ApiError(400, problems.join(' '));
      return startFakeOperation('instance_clone', instanceId);
    },
    async setInstanceAddress(instanceId, req) {
      const target = instances.find((i) => i.instanceId === instanceId);
      if (!target) throw new ApiError(404, `Instance "${instanceId}" not found.`);
      const problems = validateAddressChange({
        mode: target.mode === 'local' ? 'local' : 'production',
        ...(req.domain ? { domain: req.domain } : {}),
        ...(req.localPort !== undefined ? { localPort: req.localPort } : {}),
      });
      if (problems.length > 0) throw new ApiError(400, problems.join(' '));
      const started = startFakeOperation('instance_set_address', instanceId);
      target.domain = target.mode === 'local' ? `localhost:${req.localPort}` : req.domain!;
      return started;
    },
    async setMailer(instanceId, req) {
      if (!instances.some((i) => i.instanceId === instanceId)) {
        throw new ApiError(404, `Instance "${instanceId}" not found.`);
      }
      const started = startFakeOperation('instance_set_mailer', instanceId);
      if (req.clear === true || !req.dsn) delete mailers[instanceId];
      else mailers[instanceId] = { configured: true, redactedDsn: 'smtp://***@configured' };
      return started;
    },
    async setInstanceEnv(instanceId, req) {
      if (!instances.some((i) => i.instanceId === instanceId)) {
        throw new ApiError(404, `Instance "${instanceId}" not found.`);
      }
      // Same guards the BFF/action enforce: valid names, no managed keys.
      for (const [key, value] of Object.entries(req.overrides)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new ApiError(400, `"${key}" is not a valid environment variable name.`);
        }
        if (MANAGER_CONTROLLED_ENV_KEYS.includes(key)) {
          throw new ApiError(400, `${key} is managed by the manager and cannot be edited here.`);
        }
        if (/[\r\n]/.test(value)) {
          throw new ApiError(400, `The value for ${key} must be a single line.`);
        }
      }
      const started = startFakeOperation('instance_set_env', instanceId);
      // Reflect the overrides so a re-fetch shows the new effective values.
      const current = envConfigs[instanceId] ?? fakeEnvConfig(instanceId);
      const byKey = new Map(current.entries.map((e) => [e.key, { ...e }]));
      for (const [key, value] of Object.entries(req.overrides)) {
        const existing = byKey.get(key);
        if (existing) byKey.set(key, { ...existing, value, overridden: true });
        else byKey.set(key, { key, value, managed: false, custom: true, overridden: true });
      }
      envConfigs[instanceId] = { ...current, entries: [...byKey.values()] };
      return started;
    },
    async removeInstance(instanceId) {
      return startFakeOperation('instance_remove', instanceId);
    },
  };
}
