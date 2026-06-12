// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * In-memory ApiClient for UI tests. Mutating instance calls run the REAL
 * shared validation (`src/instance-validation.ts`) — the same rules the
 * production BFF enforces — so component/flow tests can never pass a request
 * the server would reject.
 */
import { validateAddressChange, validateCloneInstance, validateCreateInstance } from '../../instance-validation';
import { ApiError, type ApiClient, type InstanceHealthReport } from '../lib/api-client';
import type {
  BackupSummary,
  CheckResult,
  InstanceDetail,
  InstanceSummary,
  MailerStatus,
  OperationRecord,
  PreflightResult,
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
    async updateDryRun() {
      return { plan: opts.dryRunPlan ?? FAKE_DRY_RUN_PLAN };
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
    async removeInstance(instanceId) {
      return startFakeOperation('instance_remove', instanceId);
    },
  };
}
