// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Client-facing types. These mirror the JSON the Node BFF returns (see
 * `apps/web/src/server.ts`). We reuse the server's own domain types so there
 * is a single source of truth — the UI never redefines validation or wire
 * contracts.
 */
import type { BackupOrigin, BackupRetentionPolicy, BackupSchedulePolicy, InstanceMode, ReleaseChannel } from '@shm/schemas';
import type { CheckResult, CheckSeverity, ManagerUpdateCheck, RegistryVersions } from '../../actions';
import type {
  BackupScheduleStatus,
  BackupSummary,
  CleanupOrphansResult,
  CloneInstanceRequest,
  CreateInstanceRequest,
  FrontendUpdateInstanceRequest,
  InstalledPluginInfo,
  InstanceDetail,
  InstanceEnvConfig,
  InstanceEnvEntry,
  InstanceLogsResult,
  InstanceOrphanReport,
  InstanceSummary,
  LogService,
  ProxyLogsResult,
  PruneExecutionReport,
  RemoveInstanceRequest,
  SafeModeRequest,
  ServerStatus,
  SetAddressRequest,
  SetEnvRequest,
  SetMailerRequest,
  SetNameRequest,
  UpdateInstanceRequest,
} from '../../instances';
import type { OperationKind, OperationRecord, OperationStatus } from '../../jobs';

export type {
  BackupOrigin,
  BackupRetentionPolicy,
  BackupSchedulePolicy,
  BackupScheduleStatus,
  BackupSummary,
  CheckResult,
  CheckSeverity,
  CleanupOrphansResult,
  CloneInstanceRequest,
  CreateInstanceRequest,
  FrontendUpdateInstanceRequest,
  InstalledPluginInfo,
  InstanceDetail,
  InstanceEnvConfig,
  InstanceEnvEntry,
  InstanceLogsResult,
  InstanceOrphanReport,
  InstanceSummary,
  LogService,
  ProxyLogsResult,
  PruneExecutionReport,
  RemoveInstanceRequest,
  SafeModeRequest,
  ServerStatus,
  SetAddressRequest,
  SetEnvRequest,
  SetMailerRequest,
  SetNameRequest,
  UpdateInstanceRequest,
  OperationKind,
  OperationRecord,
  OperationStatus,
  InstanceMode,
  ManagerUpdateCheck,
  RegistryVersions,
  ReleaseChannel,
};

/** The state envelope returned by GET /api/state (authenticated). */
export interface Snapshot {
  mode: 'persistent';
  /** Manager version, shown in the UI header/footer. */
  managerVersion?: string;
  /**
   * Present when the caller is authenticated. Lets the SPA recover its CSRF
   * token after a page reload — the session cookie survives the reload, the
   * in-memory token does not.
   */
  session?: { email: string; roles: string[]; csrfToken: string };
}

export interface LoginResult {
  ok: boolean;
  email: string;
  roles: string[];
  csrfToken: string;
}

/** Result of POST /api/server/preflight (stateless environment checks). */
export interface PreflightResult {
  docker: CheckResult;
  internet: CheckResult;
  registry: CheckResult;
  resources: CheckResult;
  /** The registry URL that was actually checked. */
  registryUrl: string;
}

/** Redacted outbound-mail configuration (GET /api/instances/:id/mailer). */
export interface MailerStatus {
  configured: boolean;
  redactedDsn?: string;
}
