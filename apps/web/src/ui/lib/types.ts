// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Client-facing types. These mirror the JSON the Node BFF returns from
 * `snapshot()` (see `apps/web/src/server.ts`). We reuse the server's own
 * domain types so there is a single source of truth for steps, config and
 * check shapes — the UI never redefines validation or step contracts.
 */
import type { InstanceMode, ReleaseChannel } from '@shm/schemas';
import type { HealthOutcome, InstallOutcome } from '../../actions';
import type { CheckResult, CheckSeverity, WizardConfig, WizardStepId } from '../../wizard';

export type {
  CheckResult,
  CheckSeverity,
  WizardConfig,
  WizardStepId,
  HealthOutcome,
  InstallOutcome,
  InstanceMode,
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
