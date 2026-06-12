// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * In-memory ApiClient for UI tests, backed by the REAL server wizard state
 * machine (`src/wizard.ts`). This means component/flow tests exercise the same
 * gating + validation the production BFF uses — no hand-rolled snapshots.
 */
import {
  advance,
  back,
  canAdvance,
  currentStep,
  initWizard,
  recordCheck,
  setConfig,
  type WizardConfig,
  type WizardState,
  type WizardStepId,
} from '../../wizard';
import { ApiError, type ApiClient, type InstanceHealthReport } from '../lib/api-client';
import type {
  BackupSummary,
  InstanceDetail,
  InstanceSummary,
  OperationRecord,
  Snapshot,
} from '../lib/types';

export const FULL_CONFIG: WizardConfig = {
  root: '/opt/selfhelp',
  serverId: 'research-vm-1',
  mode: 'production',
  domain: 'clinic-a.example',
  letsencryptEmail: 'ops@example.com',
  registryUrl: 'https://registry.example.com/',
  channel: 'stable',
  version: 'latest',
  instanceId: 'clinic-a',
  instanceName: 'Clinic A',
  adminEmail: 'admin@example.com',
  adminName: 'Admin',
};

const CHECK_STEPS = new Set<WizardStepId>(['docker', 'internet', 'registry', 'resources', 'install', 'health']);

function driveTo(target: WizardStepId, config: WizardConfig): WizardState {
  let state = initWizard(config);
  const ok = { ok: true, severity: 'ok' as const };
  let guard = 0;
  while (currentStep(state) !== target) {
    if (guard++ > 50) throw new Error(`could not drive wizard to ${target}`);
    const step = currentStep(state);
    if (CHECK_STEPS.has(step)) state = recordCheck(state, step, ok);
    const decision = canAdvance(state);
    if (!decision.ok) throw new Error(`stuck at ${step}: ${decision.reason ?? ''}`);
    state = advance(state);
  }
  return state;
}

export interface FakeClientOptions {
  config?: Partial<WizardConfig>;
  startAt?: WizardStepId;
  failInstall?: boolean;
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

export function makeFakeClient(opts: FakeClientOptions = {}): ApiClient {
  const config: WizardConfig = { ...FULL_CONFIG, ...opts.config };
  let state = opts.startAt ? driveTo(opts.startAt, config) : initWizard(config);

  // In-memory instance/operation store for the persistent-mode console tests.
  const instances: InstanceSummary[] = opts.instances ?? [fakeInstance()];
  const backups: Record<string, BackupSummary[]> = opts.backups ?? { 'clinic-a': [fakeBackup()] };
  const operations: OperationRecord[] = [...(opts.operations ?? [])];
  let opCounter = operations.length;

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

  const snapshot = (extra?: Partial<Snapshot>): Snapshot => ({
    mode: 'bootstrap',
    step: currentStep(state),
    stepIndex: state.stepIndex,
    steps: [...state.steps],
    config: state.config,
    checks: state.checks,
    completed: state.completed,
    canAdvance: canAdvance(state),
    managerVersion: FAKE_MANAGER_VERSION,
    ...extra,
  });

  return {
    async getState() {
      return snapshot();
    },
    async setConfig(patch) {
      state = setConfig(state, patch);
      return snapshot();
    },
    async advance() {
      state = advance(state);
      return snapshot();
    },
    async back() {
      state = back(state);
      return snapshot();
    },
    async runCheck(step) {
      state = recordCheck(state, step, { ok: true, severity: 'ok', detail: `${step} check passed.` });
      return snapshot();
    },
    async listVersions() {
      return { versions: opts.availableVersions ?? ['0.3.0', '0.2.1', '0.2.0'] };
    },
    async install() {
      if (opts.failInstall) {
        return snapshot({
          outcome: {
            ok: false,
            detail: 'Provisioning failed at "wait_db": Install failed while pulling images: token=supersecret123',
            failedStep: 'wait_db',
          },
        });
      }
      state = recordCheck(state, 'install', { ok: true, severity: 'ok', detail: 'Installed.' });
      state = recordCheck(state, 'health', { ok: true, severity: 'ok', detail: 'Healthy.' });
      return snapshot({
        outcome: { ok: true, instanceDir: '/opt/selfhelp/instances/clinic-a', version: '0.1.0', publicUrl: 'https://clinic-a.example' },
        health: { healthy: true, degraded: false },
        publicUrl: 'https://clinic-a.example',
      });
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
    async login() {
      return { ok: true, email: 'owner@example.com', roles: ['server_owner'], csrfToken: 'csrf-token' };
    },
    async logout() {
      // no-op
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
      const started = startFakeOperation('instance_create', req.instanceId);
      instances.push(
        fakeInstance({
          instanceId: req.instanceId,
          displayName: req.displayName,
          domain: req.domain ?? `127.0.0.1:${req.localPort ?? 0}`,
          mode: req.mode,
        }),
      );
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
    async cloneInstance(instanceId) {
      return startFakeOperation('instance_clone', instanceId);
    },
    async removeInstance(instanceId) {
      return startFakeOperation('instance_remove', instanceId);
    },
  };
}
