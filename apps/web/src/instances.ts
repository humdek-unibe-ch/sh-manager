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
import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { HealthReport } from '@shm/core';
import type { BackupManifest, BackupOrigin, BackupSchedulePolicy, InstanceManifest, ServerInventory } from '@shm/schemas';

export type {
  BackupScheduleStatus,
  InstanceEnvConfig,
  InstanceEnvEntry,
  PruneExecutionReport,
} from '../../cli/src/actions.js';
import { InventoryStore, ManifestStore, instancePaths, type RemoveMode } from '@shm/instances';
import {
  describePluginOperation,
  drainInstanceOperations,
  drainInstancePluginOperations,
  hasPendingPluginOperations,
  instanceBackup,
  instanceBackupPrune,
  instanceBackupScheduleGet,
  instanceBackupScheduleSet,
  instanceClone,
  instanceGetEnv,
  instanceGetMailer,
  instanceHasDueScheduledBackup,
  instanceHealth,
  instanceInstall,
  instanceList,
  instanceEnable,
  instanceListInstalledPlugins,
  instanceLogs,
  instancePluginRecover,
  instanceSafeMode,
  LOG_SERVICES,
  instanceRemove,
  instanceRestore,
  instanceRunScheduledBackup,
  instanceSetAddress,
  instanceSetEnv,
  instanceSetMailer,
  instanceSetName,
  instanceUpdate,
  instanceFrontendUpdate,
  serverInit,
  serverProxyLogs,
  type ActionDeps,
  type BackupScheduleStatus,
  type InstanceEnvConfig,
  type InstalledPluginInfo,
  type InstanceFrontendUpdateOptions,
  type InstanceInstallOptions,
  type InstanceLogsResult,
  type InstanceUpdateOptions,
  type LogService,
  type MailerStatus,
  type PluginRecoverResult,
  type ProxyLogsResult,
  type PruneExecutionReport,
} from '../../cli/src/actions.js';
import { ComposeExecBackendOperationsClient } from '../../cli/src/operations-client.js';

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

/** Minimal shape of a core execution step (update/frontend update). */
interface ProgressStep {
  name: string;
  status: string;
  detail?: string;
}

/**
 * Maps a core update/frontend-update execution step name onto the coarse journal
 * phase that drives the operation step checklist (the ids in
 * `apps/web/src/ui/lib/operation-steps.ts`). Steps absent from this map are
 * still streamed to the live log, they just do not move the checklist marker —
 * so the marker only ever sits on a known row and never resets to the start.
 */
const UPDATE_STEP_PHASE: Record<string, string> = {
  backup: 'backup',
  pull: 'pull',
  'apply-artifacts': 'recreate',
  up: 'recreate',
  migrate: 'migrations',
  health: 'health',
};

/**
 * Stream one execution step into the operation journal as it happens: always log
 * the line, and advance the checklist phase for milestone steps so the operator
 * watches backup -> pull -> recreate -> migrate -> health tick by live instead
 * of seeing every step appear at once when the operation finishes.
 */
async function streamUpdateStep(ctx: OperationContext, step: ProgressStep): Promise<void> {
  await ctx.log(`${step.name}: ${step.status}${step.detail ? ` — ${step.detail}` : ''}`);
  const phase = UPDATE_STEP_PHASE[step.name];
  if (phase && step.status !== 'failed') await ctx.setPhase(phase);
}

/** Real adapter over the tested CLI actions. */
export function buildInstanceActions(opts: BuildInstanceActionsOptions): ManagerInstanceActions {
  const { deps, locks } = opts;

  async function summarize(entry: { instanceId: string; domain: string; status: string }): Promise<InstanceSummary> {
    const holder = await locks.holder(entry.instanceId);
    const busy = holder ? { operationId: holder.operationId, acquiredAt: holder.acquiredAt } : null;
    try {
      const manifest = await new ManifestStore(entry.instanceId, deps.root).read();
      return {
        instanceId: entry.instanceId,
        displayName: manifest.displayName,
        domain: entry.domain,
        mode: manifest.mode,
        status: entry.status,
        version: manifest.versions.selfhelp,
        updatedAt: manifest.updatedAt,
        // Manifest readable but still flagged broken = the inventory lost it.
        brokenReason:
          entry.status === 'broken'
            ? `Instance files exist but the server inventory does not list this instance. Run: sh-manager instance repair ${entry.instanceId}`
            : null,
        busy,
      };
    } catch (err) {
      return {
        instanceId: entry.instanceId,
        displayName: null,
        domain: entry.domain,
        mode: null,
        status: 'broken',
        version: null,
        updatedAt: null,
        brokenReason: `Instance manifest missing or invalid (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). Run: sh-manager instance repair ${entry.instanceId}`,
        busy,
      };
    }
  }

  return {
    async list() {
      // instanceList already surfaces broken state: registered instances with
      // an unreadable manifest AND on-disk instance dirs the inventory lost.
      const entries = await instanceList(deps).catch(() => [] as Awaited<ReturnType<typeof instanceList>>);
      const summaries = await Promise.all(entries.map((e) => summarize(e)));
      return summaries.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    },

    async detail(instanceId) {
      const entries = await instanceList(deps).catch(() => [] as Awaited<ReturnType<typeof instanceList>>);
      const entry = entries.find((e) => e.instanceId === instanceId);
      const paths = instancePaths(instanceId, deps.root);
      let onDisk = false;
      try {
        onDisk = (await stat(paths.dir)).isDirectory();
      } catch {
        onDisk = false;
      }
      if (!entry && !onDisk) return null;

      const summary = await summarize(entry ?? { instanceId, domain: '', status: 'broken' });
      let manifest: InstanceManifest | null = null;
      try {
        manifest = await new ManifestStore(instanceId, deps.root).read();
      } catch {
        manifest = null;
      }
      return { summary, manifest, instanceDir: paths.dir };
    },

    async backups(instanceId) {
      const paths = instancePaths(instanceId, deps.root);
      let names: string[] = [];
      try {
        names = (await readdir(paths.backupsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return [];
      }
      const out: BackupSummary[] = [];
      for (const name of names) {
        const dir = path.join(paths.backupsDir, name);
        try {
          const manifest = JSON.parse(await readFile(path.join(dir, 'backup-manifest.json'), 'utf8')) as BackupManifest;
          out.push({
            backupId: manifest.backupId,
            createdAt: manifest.createdAt,
            origin: manifest.origin ?? 'manual',
            selfhelpVersion: manifest.selfhelpVersion,
            migrationVersion: manifest.migrationVersion,
            includedAreas: manifest.includedAreas,
            pluginCount: manifest.plugins.length,
            totalBytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
            backupDir: dir,
          });
        } catch {
          // Backup dir without a readable manifest: skip from the listing.
        }
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async health(instanceId) {
      return instanceHealth(deps, instanceId);
    },

    async livePlugins(instanceId) {
      // Live read from the running instance's `plugins` table — the source of
      // truth for what is ACTUALLY installed (the manifest's recorded list can
      // lag CMS-driven installs). A down/plugin-less instance throws; surface
      // that as null so the UI falls back to the manifest instead of erroring.
      try {
        return await instanceListInstalledPlugins(deps, instanceId);
      } catch {
        return null;
      }
    },

    async serverStatus() {
      const inventory: ServerInventory | null = await new InventoryStore(deps.root).read().catch(() => null);
      if (!inventory) return { initialized: false, serverId: null, proxyNetwork: null, instanceCount: 0 };
      return {
        initialized: true,
        serverId: inventory.serverId,
        proxyNetwork: inventory.proxy.network,
        instanceCount: inventory.instances.length,
      };
    },

    async mailer(instanceId) {
      return instanceGetMailer(deps, instanceId);
    },

    async envConfig(instanceId) {
      return instanceGetEnv(deps, instanceId);
    },

    async logs(instanceId, opts) {
      return instanceLogs(deps, instanceId, opts);
    },

    async proxyLogs(opts) {
      return serverProxyLogs(deps, opts);
    },

    async updateDryRun(instanceId, req) {
      const res = await instanceUpdate(deps, instanceId, {
        dryRun: true,
        ...(req.target ? { target: req.target } : {}),
        ...(req.channel ? { channel: req.channel as InstanceUpdateOptions['channel'] } : {}),
      });
      return res.plan;
    },

    async frontendUpdateDryRun(instanceId, req) {
      const res = await instanceFrontendUpdate(deps, instanceId, {
        dryRun: true,
        ...(req.target ? { target: req.target } : {}),
        ...(req.channel ? { channel: req.channel as InstanceFrontendUpdateOptions['channel'] } : {}),
      });
      return res.plan;
    },

    async create(req, ctx) {
      // First instance on a fresh state root: initialize the server (proxy +
      // inventory) inline so the GUI needs no separate "server init" step. The
      // serverId is generated once and persisted in the inventory; reruns of a
      // half-finished first install resume via resumeInstanceId.
      const status = await this.serverStatus();
      if (!status.initialized) {
        await ctx.setPhase('server init');
        const init = await serverInit(deps, {
          serverId: `srv-${randomBytes(4).toString('hex')}`,
          mode: req.mode,
          ...(req.letsencryptEmail ? { letsencryptEmail: req.letsencryptEmail } : {}),
          resumeInstanceId: req.instanceId,
        });
        await ctx.log(`Server initialized (proxy + inventory at ${init.inventoryPath}).`);
      }

      await ctx.setPhase('install');
      const installOpts: InstanceInstallOptions = {
        instanceId: req.instanceId,
        displayName: req.displayName,
        mode: req.mode,
        ...(req.domain ? { domain: req.domain } : {}),
        ...(req.localPort !== undefined ? { localPort: req.localPort } : {}),
        registryUrl: req.registryUrl,
        ...(req.channel ? { channel: req.channel as InstanceInstallOptions['channel'] } : {}),
        ...(req.version ? { version: req.version } : {}),
        provision: true,
        adminEmail: req.adminEmail,
        ...(req.adminName ? { adminName: req.adminName } : {}),
        ...(req.mailerDsn ? { mailerDsn: req.mailerDsn } : {}),
        // Journal each install stage as the operation phase: the create wizard
        // renders these as a live step checklist (registry → compose → start →
        // wait_db → migrations → … → health).
        onStep: (step) => ctx.setPhase(step),
      };
      const res = await instanceInstall(deps, installOpts);
      await ctx.log(`Installed ${req.instanceId} at version ${res.version}.`);
      if (res.provision) {
        for (const step of res.provision.steps) {
          await ctx.log(`provision ${step.name}: ${step.status}${step.detail ? ` — ${step.detail}` : ''}`);
        }
      }
      // The generated admin password NEVER enters the journal (redaction would
      // strip it anyway); the operator retrieves it from the 0600 server-side
      // file that provisioning wrote.
      return {
        instanceDir: res.instanceDir,
        version: res.version,
        provisioned: res.provision?.ok ?? res.broughtUp,
        adminPasswordFile: res.adminPasswordFile ?? null,
        domainWarnings: res.domainWarnings,
      };
    },

    async update(instanceId, req, ctx) {
      await ctx.setPhase('plan');
      const res = await instanceUpdate(deps, instanceId, {
        ...(req.target ? { target: req.target } : {}),
        ...(req.channel ? { channel: req.channel as InstanceUpdateOptions['channel'] } : {}),
        acceptMigrationRisk: req.acceptMigrationRisk ?? false,
        approveMysqlMajor: req.approveMysqlMajor ?? false,
        // Stream each execution step into the journal live (log + checklist phase)
        // so the operator sees backup -> pull -> recreate -> migrate -> health
        // advance one by one instead of all at once when the update finishes.
        onStep: (step) => streamUpdateStep(ctx, step),
      });
      if (!res.executed) {
        await ctx.log(`Update not executed (${res.plan.status}): ${res.plan.reasons.join('; ') || 'no reason given'}`);
        return { executed: false, plan: res.plan };
      }
      return {
        executed: true,
        ok: res.report?.ok ?? false,
        rolledBack: res.report?.rolledBack ?? false,
        toVersion: res.plan.core?.version ?? null,
      };
    },

    async frontendUpdate(instanceId, req, ctx) {
      await ctx.setPhase('plan');
      const res = await instanceFrontendUpdate(deps, instanceId, {
        ...(req.target ? { target: req.target } : {}),
        ...(req.channel ? { channel: req.channel as InstanceFrontendUpdateOptions['channel'] } : {}),
        // Stream each execution step live (see `update` above).
        onStep: (step) => streamUpdateStep(ctx, step),
      });
      if (!res.executed) {
        await ctx.log(
          `Frontend update not executed (${res.plan.status}): ${res.plan.reasons.join('; ') || 'no newer frontend available'}`,
        );
        return { executed: false, plan: res.plan };
      }
      return {
        executed: true,
        ok: res.report?.ok ?? false,
        rolledBack: res.report?.rolledBack ?? false,
        toVersion: res.plan.targetFrontendVersion,
      };
    },

    async backup(instanceId, ctx) {
      // Drive the live checklist from the backup's own stages (database →
      // metadata → volumes → manifest) instead of one opaque "backup" phase.
      await ctx.setPhase('database');
      const res = await instanceBackup(deps, instanceId, {
        onStep: async (s) => {
          await ctx.setPhase(s.phase);
          await ctx.log(s.detail);
        },
      });
      await ctx.log(`Backup ${res.backupId} written to ${res.backupDir}.`);
      return {
        backupId: res.backupId,
        backupDir: res.backupDir,
        includedAreas: res.manifest.includedAreas,
        files: res.manifest.files.length,
      };
    },

    async restore(instanceId, req, ctx) {
      // Safety net first: an automatic pre-restore backup so the operator can
      // undo a restore that targeted the wrong snapshot. Keep the macro phase on
      // "pre-restore backup" and surface its inner stages as log lines (so the
      // checklist row stays put while the log shows what the backup is doing).
      await ctx.setPhase('pre-restore backup');
      const pre = await instanceBackup(deps, instanceId, {
        origin: 'pre_restore',
        onStep: async (s) => ctx.log(`pre-restore backup: ${s.detail}`),
      });
      await ctx.log(`Pre-restore backup ${pre.backupId} written to ${pre.backupDir}.`);

      // The restore then drives the checklist row-by-row (verify → stop →
      // volumes → database → config → recreate → migrate → health).
      const res = await instanceRestore(deps, instanceId, req.backupId, {
        mode: 'same_instance',
        apply: true,
        onStep: async (s) => {
          await ctx.setPhase(s.phase);
          await ctx.log(s.detail);
        },
      });
      if (!res.validation.ok || !res.plan) {
        throw new Error(`Restore blocked: ${res.validation.errors.join('; ')}`);
      }
      for (const step of res.plan.steps) await ctx.log(`plan: ${step}`);
      if (res.migrated) await ctx.log('Ran forward migrations (restored DB head differed from running code).');
      return {
        restoredFrom: req.backupId,
        preRestoreBackupId: pre.backupId,
        migrated: res.migrated ?? false,
        health: res.health ?? null,
      };
    },

    async clone(sourceInstanceId, req, ctx) {
      await ctx.setPhase('plan');
      // Log the upfront plan first so the operator sees what will happen, then
      // advance the checklist phase live as each milestone is reached.
      const res = await instanceClone(deps, sourceInstanceId, req.targetInstanceId, {
        ...(req.targetDomain ? { targetDomain: req.targetDomain } : {}),
        ...(req.targetLocalPort !== undefined ? { targetLocalPort: req.targetLocalPort } : {}),
        ...(req.displayName ? { displayName: req.displayName } : {}),
        apply: true,
        onPhase: async (phase, detail) => {
          if (detail) await ctx.log(detail);
          await ctx.setPhase(phase);
        },
      });
      return {
        targetInstanceId: req.targetInstanceId,
        executed: res.executed ?? false,
        health: res.health ?? null,
      };
    },

    async setAddress(instanceId, req, ctx) {
      await ctx.setPhase('apply address');
      const res = await instanceSetAddress(deps, instanceId, {
        ...(req.domain ? { domain: req.domain } : {}),
        ...(req.localPort !== undefined ? { localPort: req.localPort } : {}),
        restart: true,
      });
      await ctx.log(
        res.changed
          ? `Address changed: ${res.previousDomain} -> ${res.domain}.`
          : `Configuration re-applied for ${res.domain} (address unchanged).`,
      );
      for (const w of res.warnings) await ctx.log(`warning: ${w}`);
      await ctx.log(`Containers recreated; instance reachable at ${res.publicUrl}.`);
      return {
        changed: res.changed,
        previousDomain: res.previousDomain,
        domain: res.domain,
        publicUrl: res.publicUrl,
        warnings: res.warnings,
        health: res.health ?? null,
      };
    },

    async setMailer(instanceId, req, ctx) {
      await ctx.setPhase('apply mailer');
      const clear = req.clear === true || req.dsn === '' || req.dsn === undefined;
      const res = await instanceSetMailer(deps, instanceId, clear ? { clear: true } : { dsn: req.dsn!, restart: true });
      await ctx.log(
        res.configured
          ? `Mailer DSN set (${res.redactedDsn}); containers restarted.`
          : 'Mailer DSN cleared; instance falls back to the bundled Mailpit.',
      );
      return { configured: res.configured, redactedDsn: res.redactedDsn ?? null, restarted: res.restarted };
    },

    async setName(instanceId, req, ctx) {
      await ctx.setPhase('rename');
      const res = await instanceSetName(deps, instanceId, { displayName: req.displayName });
      await ctx.log(
        res.changed
          ? `Display name changed: "${res.previousName}" -> "${res.displayName}".`
          : `Display name unchanged ("${res.displayName}").`,
      );
      return { changed: res.changed, previousName: res.previousName, displayName: res.displayName };
    },

    async setEnv(instanceId, req, ctx) {
      await ctx.setPhase('apply environment');
      const res = await instanceSetEnv(deps, instanceId, { overrides: req.overrides, restart: true });
      await ctx.log(
        `Applied ${res.applied} environment override${res.applied === 1 ? '' : 's'}; containers recreated.`,
      );
      return { applied: res.applied, restarted: res.restarted, health: res.health ?? null };
    },

    async disable(instanceId, ctx) {
      await ctx.setPhase('disable');
      // Disable is exactly the `disable` removal mode (compose stop + status
      // disabled), reused so there is a single tested code path; it is just
      // journaled under its own `instance_disable` kind now that it is a
      // first-class toggle rather than a hidden "Remove" option.
      const res = await instanceRemove(deps, instanceId, { mode: 'disable' });
      if (!res.ok) throw new Error(`Disable blocked: ${res.errors.join('; ')}`);
      await ctx.log(`Disabled ${instanceId}: stopped the containers, kept all data (reversible via Enable).`);
      return { executed: res.executed };
    },

    async enable(instanceId, ctx) {
      await ctx.setPhase('enable');
      const res = await instanceEnable(deps, instanceId);
      if (!res.ok) throw new Error(`Enable blocked: ${res.errors.join('; ')}`);
      await ctx.log(
        res.recreated
          ? `Enabled ${instanceId}: recreated the containers and marked it active.`
          : `Enabled ${instanceId}: started the containers and marked it active.`,
      );
      return { executed: res.executed, recreated: res.recreated, health: res.health ?? null };
    },

    async safeMode(instanceId, req, ctx) {
      await ctx.setPhase(req.enable ? 'safe-mode enable' : 'safe-mode disable');
      await instanceSafeMode(deps, instanceId, req.enable);
      await ctx.log(
        req.enable
          ? `Safe mode enabled for ${instanceId}: the backend now boots with core bundles only (plugins disabled). Restart it if it is currently crash-looping.`
          : `Safe mode disabled for ${instanceId}: plugins load again on the next boot.`,
      );
      return { enabled: req.enable };
    },

    async pluginRecover(instanceId, ctx): Promise<PluginRecoverResult> {
      await ctx.setPhase('plugin-recover');
      // Fire the action's step log into the operation journal as it progresses
      // (the callback is synchronous; the journal serializes the writes).
      const res = await instancePluginRecover(deps, instanceId, {
        log: (line) => {
          void ctx.log(line);
        },
      });
      await ctx.log(
        res.recovered
          ? `Recovered ${instanceId}: the backend booted cleanly with plugins enabled.`
          : `Recovery incomplete for ${instanceId}: safe mode was left enabled to keep it up. Re-trigger the plugin uninstall from the CMS admin or restore a backup.`,
      );
      return res;
    },

    async remove(instanceId, req, ctx) {
      await ctx.setPhase(`remove (${req.mode})`);
      const res = await instanceRemove(deps, instanceId, {
        mode: req.mode,
        ...(req.deleteVolumes !== undefined ? { deleteVolumes: req.deleteVolumes } : {}),
        ...(req.deleteBackups !== undefined ? { deleteBackups: req.deleteBackups } : {}),
        ...(req.confirm !== undefined ? { confirm: req.confirm } : {}),
      });
      if (!res.ok) throw new Error(`Remove blocked: ${res.errors.join('; ')}`);
      await ctx.log(`Removed ${instanceId} (mode ${req.mode}).`);
      return { mode: req.mode, executed: res.executed };
    },

    async peekPendingCmsWork(instanceId) {
      const client = new ComposeExecBackendOperationsClient({
        runner: deps.runner,
        instanceDir: instancePaths(instanceId, deps.root).dir,
        instanceId,
      });
      const pending = await client.fetchPending(instanceId);
      const systemUpdate: PendingCmsWork['systemUpdate'] = pending
        ? pending.kind === 'frontend'
          ? 'frontend'
          : 'core'
        : null;
      // Managed-mode plugin installs/updates/uninstalls/purges parked by the CMS
      // for the operator (the manager) count as pending work for the poller too.
      const pluginOps = await hasPendingPluginOperations(deps, instanceId);
      return { systemUpdate, pluginOps };
    },

    async drainCmsOperations(instanceId, ctx) {
      const client = new ComposeExecBackendOperationsClient({
        runner: deps.runner,
        instanceDir: instancePaths(instanceId, deps.root).dir,
        instanceId,
      });
      // Mirror the update's live lifecycle phases into the manager journal so a
      // CMS-requested core/frontend update lights up its real step checklist
      // (resolve → backup → pull → recreate → migrate → health) AS IT RUNS,
      // instead of only showing the steps after the fact.
      const outcomes = await drainInstanceOperations(deps, instanceId, client, async (op, status, _percent, detail) => {
        const step = cmsUpdatePhaseStep(op.kind, status);
        if (step) await ctx.setPhase(step);
        if (detail) await ctx.log(`Update to ${op.targetVersion}: ${detail}`);
      });
      const lines: string[] = [];
      for (const outcome of outcomes) {
        if (outcome.result === 'noop') continue;
        const line =
          outcome.result === 'rejected'
            ? `Operation ${outcome.operationId} rejected (${outcome.status}): ${outcome.reason}`
            : `Operation ${outcome.operationId} finished: ${outcome.status}.`;
        lines.push(line);
        await ctx.log(line);
      }

      // Plugin operations second: a system update drained above may already
      // have reinstalled plugins as part of its own execution. `onPlanned`
      // fires before any composer step so the journaled operation says WHAT it
      // is doing (e.g. "Installing plugin sh-shp-survey-js 0.2.1") instead of
      // the opaque "cms operations drain" — so operators can tell a drain was a
      // plugin install/update/uninstall.
      const pluginReport = await drainInstancePluginOperations(deps, instanceId, {
        log: (l) => ctx.log(l),
        onPlanned: async (ops) => {
          if (ops.length === 0) return;
          const summary = ops.map(describePluginOperation).join('; ');
          await ctx.setPhase(ops.length === 1 ? summary : `Applying ${ops.length} plugin changes`);
          await ctx.log(`Plugin operations requested in the CMS: ${summary}.`);
        },
      });
      for (const outcome of pluginReport.outcomes) {
        const line =
          outcome.status === 'done'
            ? `Plugin ${outcome.type} ${outcome.pluginId} (operation #${outcome.operationId}) finished.`
            : `Plugin ${outcome.type} ${outcome.pluginId} (operation #${outcome.operationId}) failed: ${outcome.detail ?? 'unknown error'}`;
        lines.push(line);
        await ctx.log(line);
      }
      if (pluginReport.restarted) {
        await ctx.log('Symfony services restarted with the updated plugin state.');
      }
      return { processed: lines.length, outcomes: lines };
    },

    async backupSchedule(instanceId) {
      return instanceBackupScheduleGet(deps, instanceId);
    },

    async setBackupSchedule(instanceId, policy) {
      return instanceBackupScheduleSet(deps, instanceId, policy);
    },

    async backupPrunePlan(instanceId) {
      return instanceBackupPrune(deps, instanceId, { dryRun: true });
    },

    async backupPrune(instanceId, ctx) {
      await ctx.setPhase('prune backups');
      const res = await instanceBackupPrune(deps, instanceId, {});
      for (const d of res.plan.prune) await ctx.log(`prune ${d.backupId}: ${d.reasons.join(', ')}`);
      for (const s of res.skipped) await ctx.log(`skipped ${s.name}: ${s.reason}`);
      await ctx.log(`Deleted ${res.deleted.length} backup(s); kept ${res.plan.keep.length}.`);
      return { deleted: res.deleted, kept: res.plan.keep.length };
    },

    async hasDueScheduledBackup(instanceId) {
      return instanceHasDueScheduledBackup(deps, instanceId);
    },

    async runScheduledBackup(instanceId, ctx) {
      await ctx.setPhase('scheduled backup');
      const entry = await instanceRunScheduledBackup(deps, instanceId, { log: (l) => void ctx.log(l) });
      if (entry.action === 'failed') throw new Error(entry.detail ?? 'Scheduled backup failed.');
      return entry;
    },
  };
}

/** True when an inventory entry should be drained by the CMS poller. */
export function isPollable(summary: InstanceSummary): boolean {
  return summary.status === 'active' && summary.busy === null;
}

/**
 * Maps a CMS update's coarse lifecycle status onto the manager journal step id
 * for {@link buildOperationSteps} (the `instance_update` /
 * `instance_frontend_update` step maps), so the operator's live checklist
 * advances row-by-row. Returns `null` for statuses with no dedicated row
 * (terminal states are reflected by the operation's own success/failure).
 */
export function cmsUpdatePhaseStep(kind: 'core' | 'frontend' | undefined, status: string): string | null {
  const frontend = kind === 'frontend';
  switch (status) {
    case 'accepted':
    case 'preflight_running':
      return 'plan';
    case 'backup_running':
      return frontend ? null : 'backup';
    case 'update_running':
      return 'pull';
    case 'migration_running':
      return 'migrations';
    case 'health_check_running':
      return 'health';
    default:
      return null;
  }
}
