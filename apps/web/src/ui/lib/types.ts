// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Client-facing types. These mirror the JSON the Node BFF returns from
 * `snapshot()` (see `apps/web/src/server.ts`). We reuse the server's own
 * domain types so there is a single source of truth for steps, config and
 * check shapes — the UI never redefines validation or step contracts.
 */
import type { InstanceMode, ReleaseChannel } from '@shm/schemas';
import type { HealthOutcome, InstallOutcome, ManagerUpdateCheck, RegistryVersions } from '../../actions';
import type {
  BackupSummary,
  CloneInstanceRequest,
  CreateInstanceRequest,
  InstanceDetail,
  InstanceSummary,
  RemoveInstanceRequest,
  UpdateInstanceRequest,
} from '../../instances';
import type { OperationRecord, OperationStatus } from '../../jobs';
import type { CheckResult, CheckSeverity, WizardConfig, WizardStepId } from '../../wizard';

export type {
  BackupSummary,
  CheckResult,
  CheckSeverity,
  CloneInstanceRequest,
  CreateInstanceRequest,
  InstanceDetail,
  InstanceSummary,
  RemoveInstanceRequest,
  UpdateInstanceRequest,
  OperationRecord,
  OperationStatus,
  WizardConfig,
  WizardStepId,
  HealthOutcome,
  InstallOutcome,
  InstanceMode,
  ManagerUpdateCheck,
  RegistryVersions,
  ReleaseChannel,
};

export type ServerMode = 'bootstrap' | 'persistent';

export interface AdvanceDecision {
  ok: boolean;
  reason?: string;
}

/** The state envelope returned by every wizard API endpoint. */
export interface Snapshot {
  mode: ServerMode;
  step: WizardStepId;
  stepIndex: number;
  steps: WizardStepId[];
  config: WizardConfig;
  checks: Partial<Record<WizardStepId, CheckResult>>;
  completed: boolean;
  canAdvance: AdvanceDecision;
  /** Manager version, shown in the UI header/footer. */
  managerVersion?: string;
  /**
   * Present when the caller is authenticated (persistent mode). Lets the SPA
   * recover its CSRF token after a page reload — the session cookie survives
   * the reload, the in-memory token does not.
   */
  session?: { email: string; roles: string[]; csrfToken: string };
  /** Present only on the `/api/install` response. */
  outcome?: InstallOutcome;
  health?: HealthOutcome;
  publicUrl?: string;
}

/** The result we keep client-side after a successful in-session install. */
export interface InstallResult {
  outcome: InstallOutcome;
  health?: HealthOutcome;
  publicUrl?: string;
}

export interface LoginResult {
  ok: boolean;
  email: string;
  roles: string[];
  csrfToken: string;
}
