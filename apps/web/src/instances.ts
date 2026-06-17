// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance-management seam for the persistent manager GUI.
 *
 * The HTTP layer (server.ts) and the background CMS-operations poller depend
 * on this interface; the real adapter ({@link buildInstanceActions}) wraps the
 * existing, tested CLI actions (apps/cli/src/actions.ts) so the GUI and the
 * CLI share one implementation of every lifecycle operation.
 *
 * Read APIs are synchronous request/response. Mutating APIs are executed
 * INSIDE an OperationRunner body (jobs.ts) by the caller: they receive the
 * {@link OperationContext} for phase/log reporting and their results land in
 * the redacted operation journal.
 */
import type { HealthReport } from '@shm/core';
import type { BackupOrigin, BackupSchedulePolicy, InstanceManifest } from '@shm/schemas';

export type {
  BackupScheduleStatus,
  InstanceEnvConfig,
  InstanceEnvEntry,
  PruneExecutionReport,
} from '@shm/app-actions';
import type { RemoveMode } from '@shm/instances';
import {
  LOG_SERVICES,
  type ActionDeps,
  type BackupScheduleStatus,
  type InstanceEnvConfig,
  type InstalledPluginInfo,
  type InstanceLogsResult,
  type LogService,
  type MailerStatus,
  type ProxyLogsResult,
  type PruneExecutionReport,
} from '@shm/app-actions';

/** Re-exported so the BFF can validate the `?service=` query without reaching into the CLI package. */
export { LOG_SERVICES };
export type { LogService, InstanceLogsResult, ProxyLogsResult };
import type { InstanceLocks, OperationContext } from './jobs.js';

export interface InstanceSummary {
  instanceId: string;
  displayName: string | null;
  domain: string;
  mode: string | null;
  /** Inventory status (active/disabled/...) or "broken" when state is damaged. */
  status: string;
  version: string | null;
  updatedAt: string | null;
  /** Why the instance is considered broken (missing/invalid manifest, ...). */
  brokenReason: string | null;
  /** Mutating operation currently holding this instance's lock, if any. */
  busy: { operationId: string; acquiredAt: string } | null;
}

export interface InstanceDetail {
  summary: InstanceSummary;
  manifest: InstanceManifest | null;
  instanceDir: string;
}

/**
 * What the CMS has parked for the manager on one instance, as a cheap peek.
 * `systemUpdate` is the kind of a requested core/frontend update (so the poller
 * can journal it under its real operation kind); `pluginOps` flags parked
 * managed-mode plugin install/update/uninstall/purge work.
 */
export interface PendingCmsWork {
  systemUpdate: 'core' | 'frontend' | null;
  pluginOps: boolean;
}

export interface BackupSummary {
  backupId: string;
  createdAt: string;
  /** Why the backup exists (legacy manifests without the field = manual). */
  origin: BackupOrigin;
  selfhelpVersion: string;
  migrationVersion: string;
  includedAreas: string[];
  pluginCount: number;
  totalBytes: number;
  /** Server-side directory (no browser download in this phase). */
  backupDir: string;
}

export interface CreateInstanceRequest {
  instanceId: string;
  displayName: string;
  mode: 'local' | 'production';
  domain?: string;
  localPort?: number;
  registryUrl: string;
  channel?: string;
  version?: string;
  adminEmail: string;
  adminName?: string;
  /** Optional SMTP DSN; stored in the instance's 0600 secrets.env. */
  mailerDsn?: string;
  /**
   * Let's Encrypt contact email, used ONLY when this install also initializes
   * a fresh server in production mode (first instance creates the proxy).
   */
  letsencryptEmail?: string;
}

export interface UpdateInstanceRequest {
  target?: string;
  channel?: string;
  acceptMigrationRisk?: boolean;
  approveMysqlMajor?: boolean;
}

export interface FrontendUpdateInstanceRequest {
  /** Target frontend version, or 'latest' (default). */
  target?: string;
  channel?: string;
}

export interface RestoreInstanceRequest {
  backupId: string;
}

export interface CloneInstanceRequest {
  targetInstanceId: string;
  /** Production sources: the clone's new public domain. */
  targetDomain?: string;
  /** Local sources: the clone's new published localhost port. */
  targetLocalPort?: number;
  /** Operator-facing name for the clone; defaults to the clone's own id. */
  displayName?: string;
}

export interface SetAddressRequest {
  /** Production instances: the new public domain. */
  domain?: string;
  /** Local instances: the new published localhost port. */
  localPort?: number;
}

export interface RemoveInstanceRequest {
  mode: RemoveMode;
  deleteVolumes?: boolean;
  deleteBackups?: boolean;
  confirm?: string;
}

export interface SetMailerRequest {
  /** New SMTP DSN; empty string or `clear: true` removes the override. */
  dsn?: string;
  clear?: boolean;
}

export interface SafeModeRequest {
  /**
   * `true` enables safe mode (the backend boots with core bundles only, plugins
   * disabled); `false` disables it (plugins load again on the next boot).
   */
  enable: boolean;
}

export interface SetNameRequest {
  /** New operator-facing display name (the instanceId is never changed). */
  displayName: string;
}

export interface SetEnvRequest {
  /** Full set of operator overrides to persist (replaces the previous set). */
  overrides: Record<string, string>;
}

/** Whether this state root is an initialized SelfHelp server. */
export interface ServerStatus {
  initialized: boolean;
  serverId: string | null;
  proxyNetwork: string | null;
  instanceCount: number;
}

export type { InstalledPluginInfo };

export interface ManagerInstanceActions {
  list(): Promise<InstanceSummary[]>;
  detail(instanceId: string): Promise<InstanceDetail | null>;
  backups(instanceId: string): Promise<BackupSummary[]>;
  health(instanceId: string): Promise<HealthReport>;
  /**
   * Plugins ACTUALLY installed in the running instance (live DB read), or null
   * when the instance is down / has no plugin support so the UI can fall back to
   * the manifest's recorded list.
   */
  livePlugins(instanceId: string): Promise<InstalledPluginInfo[] | null>;
  /** Is this state root an initialized server (inventory exists)? */
  serverStatus(): Promise<ServerStatus>;
  /** Redacted outbound-mail configuration of an instance. */
  mailer(instanceId: string): Promise<MailerStatus>;
  /** Effective non-secret environment of an instance (read-only view). */
  envConfig(instanceId: string): Promise<InstanceEnvConfig>;
  /** Recent (redacted) container logs for one service of an instance. */
  logs(instanceId: string, opts: { service?: LogService; tail?: number }): Promise<InstanceLogsResult>;
  /** Recent (redacted) logs from the shared Traefik proxy (edge routing / TLS / Docker provider). */
  proxyLogs(opts: { tail?: number }): Promise<ProxyLogsResult>;
  /** Plan-only update preview (never mutates). */
  updateDryRun(instanceId: string, req: UpdateInstanceRequest): Promise<unknown>;
  /** Plan-only frontend-only update preview (never mutates). */
  frontendUpdateDryRun(instanceId: string, req: FrontendUpdateInstanceRequest): Promise<unknown>;

  create(req: CreateInstanceRequest, ctx: OperationContext): Promise<unknown>;
  update(instanceId: string, req: UpdateInstanceRequest, ctx: OperationContext): Promise<unknown>;
  /** Update ONLY the frontend (stateless swap; core + data untouched). */
  frontendUpdate(instanceId: string, req: FrontendUpdateInstanceRequest, ctx: OperationContext): Promise<unknown>;
  backup(instanceId: string, ctx: OperationContext): Promise<unknown>;
  /** Takes an automatic pre-restore backup, then applies the restore. */
  restore(instanceId: string, req: RestoreInstanceRequest, ctx: OperationContext): Promise<unknown>;
  clone(sourceInstanceId: string, req: CloneInstanceRequest, ctx: OperationContext): Promise<unknown>;
  /** Changes the routed domain / local port and restarts the instance. */
  setAddress(instanceId: string, req: SetAddressRequest, ctx: OperationContext): Promise<unknown>;
  /** Sets or clears the instance's SMTP DSN and restarts it. */
  setMailer(instanceId: string, req: SetMailerRequest, ctx: OperationContext): Promise<unknown>;
  /** Renames the instance's display name only (metadata; no restart). */
  setName(instanceId: string, req: SetNameRequest, ctx: OperationContext): Promise<unknown>;
  /** Persists operator env overrides, regenerates `.env`, and restarts the instance. */
  setEnv(instanceId: string, req: SetEnvRequest, ctx: OperationContext): Promise<unknown>;
  /**
   * Stops the instance's containers but keeps every volume/secret/manifest and
   * the inventory entry (status -> `disabled`). Reversible via {@link enable}.
   */
  disable(instanceId: string, ctx: OperationContext): Promise<unknown>;
  /**
   * Brings a `disabled` (or `removed_keep_data`) instance back online (`up -d`,
   * remount plugins, status -> `active`). The inverse of {@link disable}.
   */
  enable(instanceId: string, ctx: OperationContext): Promise<unknown>;
  /**
   * Toggles the backend's safe-mode marker. While enabled the kernel boots with
   * core bundles only (plugins disabled) — the one toggle that revives a backend
   * crash-looping on a half-removed plugin, since it works even when the PHP
   * console is unbootable.
   */
  safeMode(instanceId: string, req: SafeModeRequest, ctx: OperationContext): Promise<unknown>;
  /**
   * Recovers a backend that crash-loops after a half-removed plugin
   * (`Class "...Bundle" not found`): boot in safe mode, finalize the pending
   * uninstall, repair the bundle registration from the database, then verify a
   * clean (plugins-on) boot.
   */
  pluginRecover(instanceId: string, ctx: OperationContext): Promise<unknown>;
  remove(instanceId: string, req: RemoveInstanceRequest, ctx: OperationContext): Promise<unknown>;
  /**
   * Cheap read-only peek: what CMS-requested work is waiting for the manager?
   * Lets the poller avoid creating a journal row on every idle tick AND journal
   * a core/frontend update under its real kind (so the operation history reads
   * "instance core update", not the opaque "Plugin / CMS operation" drain).
   */
  peekPendingCmsWork(instanceId: string): Promise<PendingCmsWork>;
  /** Drain pending CMS-requested update operations (used by the poller). */
  drainCmsOperations(instanceId: string, ctx: OperationContext): Promise<{ processed: number; outcomes: string[] }>;

  /** Schedule policy + run state + footprint estimate (read-only). */
  backupSchedule(instanceId: string): Promise<BackupScheduleStatus>;
  /** Validates and persists the schedule policy on the instance manifest. */
  setBackupSchedule(instanceId: string, policy: BackupSchedulePolicy): Promise<BackupScheduleStatus>;
  /** Read-only GFS keep/prune preview (deletes nothing). */
  backupPrunePlan(instanceId: string): Promise<PruneExecutionReport>;
  /** Applies the GFS retention policy (runs inside the OperationRunner). */
  backupPrune(instanceId: string, ctx: OperationContext): Promise<unknown>;
  /**
   * Cheap read-only peek: is a scheduled backup due? Lets the scheduler loop
   * avoid creating a journal row on every idle tick.
   */
  hasDueScheduledBackup(instanceId: string): Promise<boolean>;
  /** Takes the due scheduled backup + prunes (used by the scheduler loop). */
  runScheduledBackup(instanceId: string, ctx: OperationContext): Promise<unknown>;
}

export interface BuildInstanceActionsOptions {
  deps: ActionDeps;
  locks: InstanceLocks;
}

/** Real adapter over the shared application-service layer; see `instances/adapter.ts`. */
export { buildInstanceActions } from './instances/adapter.js';

/** CMS-phase mapping helpers; see `instances/cms-phase.ts`. */
export { isPollable, cmsUpdatePhaseStep } from './instances/cms-phase.js';
