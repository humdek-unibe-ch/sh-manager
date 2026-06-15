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
  instanceRemove,
  instanceRestore,
  instanceRunScheduledBackup,
  instanceSetAddress,
  instanceSetEnv,
  instanceSetMailer,
  instanceUpdate,
  serverInit,
  type ActionDeps,
  type BackupScheduleStatus,
  type InstanceEnvConfig,
  type InstanceInstallOptions,
  type InstanceUpdateOptions,
  type MailerStatus,
  type PruneExecutionReport,
} from '../../cli/src/actions.js';
import { ComposeExecBackendOperationsClient } from '../../cli/src/operations-client.js';
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

export interface RestoreInstanceRequest {
  backupId: string;
}

export interface CloneInstanceRequest {
  targetInstanceId: string;
  /** Production sources: the clone's new public domain. */
  targetDomain?: string;
  /** Local sources: the clone's new published localhost port. */
  targetLocalPort?: number;
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

export interface ManagerInstanceActions {
  list(): Promise<InstanceSummary[]>;
  detail(instanceId: string): Promise<InstanceDetail | null>;
  backups(instanceId: string): Promise<BackupSummary[]>;
  health(instanceId: string): Promise<HealthReport>;
  /** Is this state root an initialized server (inventory exists)? */
  serverStatus(): Promise<ServerStatus>;
  /** Redacted outbound-mail configuration of an instance. */
  mailer(instanceId: string): Promise<MailerStatus>;
  /** Effective non-secret environment of an instance (read-only view). */
  envConfig(instanceId: string): Promise<InstanceEnvConfig>;
  /** Plan-only update preview (never mutates). */
  updateDryRun(instanceId: string, req: UpdateInstanceRequest): Promise<unknown>;

  create(req: CreateInstanceRequest, ctx: OperationContext): Promise<unknown>;
  update(instanceId: string, req: UpdateInstanceRequest, ctx: OperationContext): Promise<unknown>;
  backup(instanceId: string, ctx: OperationContext): Promise<unknown>;
  /** Takes an automatic pre-restore backup, then applies the restore. */
  restore(instanceId: string, req: RestoreInstanceRequest, ctx: OperationContext): Promise<unknown>;
  clone(sourceInstanceId: string, req: CloneInstanceRequest, ctx: OperationContext): Promise<unknown>;
  /** Changes the routed domain / local port and restarts the instance. */
  setAddress(instanceId: string, req: SetAddressRequest, ctx: OperationContext): Promise<unknown>;
  /** Sets or clears the instance's SMTP DSN and restarts it. */
  setMailer(instanceId: string, req: SetMailerRequest, ctx: OperationContext): Promise<unknown>;
  /** Persists operator env overrides, regenerates `.env`, and restarts the instance. */
  setEnv(instanceId: string, req: SetEnvRequest, ctx: OperationContext): Promise<unknown>;
  remove(instanceId: string, req: RemoveInstanceRequest, ctx: OperationContext): Promise<unknown>;
  /**
   * Cheap read-only peek: is a CMS-requested operation waiting? Lets the
   * poller avoid creating a journal row on every idle tick.
   */
  hasPendingCmsOperation(instanceId: string): Promise<boolean>;
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

    async updateDryRun(instanceId, req) {
      const res = await instanceUpdate(deps, instanceId, {
        dryRun: true,
        ...(req.target ? { target: req.target } : {}),
        ...(req.channel ? { channel: req.channel as InstanceUpdateOptions['channel'] } : {}),
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
      });
      if (!res.executed) {
        await ctx.log(`Update not executed (${res.plan.status}): ${res.plan.reasons.join('; ') || 'no reason given'}`);
        return { executed: false, plan: res.plan };
      }
      for (const step of res.report?.steps ?? []) {
        await ctx.log(`${step.name}: ${step.status}${step.detail ? ` — ${step.detail}` : ''}`);
      }
      return {
        executed: true,
        ok: res.report?.ok ?? false,
        rolledBack: res.report?.rolledBack ?? false,
        toVersion: res.plan.core?.version ?? null,
      };
    },

    async backup(instanceId, ctx) {
      await ctx.setPhase('backup');
      const res = await instanceBackup(deps, instanceId, {});
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
      // undo a restore that targeted the wrong snapshot.
      await ctx.setPhase('pre-restore backup');
      const pre = await instanceBackup(deps, instanceId, { origin: 'pre_restore' });
      await ctx.log(`Pre-restore backup ${pre.backupId} written to ${pre.backupDir}.`);

      await ctx.setPhase('restore');
      const res = await instanceRestore(deps, instanceId, req.backupId, { mode: 'same_instance', apply: true });
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
      await ctx.setPhase('clone');
      const res = await instanceClone(deps, sourceInstanceId, req.targetInstanceId, {
        ...(req.targetDomain ? { targetDomain: req.targetDomain } : {}),
        ...(req.targetLocalPort !== undefined ? { targetLocalPort: req.targetLocalPort } : {}),
        apply: true,
      });
      for (const step of res.plan.steps) await ctx.log(`plan: ${step}`);
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

    async setEnv(instanceId, req, ctx) {
      await ctx.setPhase('apply environment');
      const res = await instanceSetEnv(deps, instanceId, { overrides: req.overrides, restart: true });
      await ctx.log(
        `Applied ${res.applied} environment override${res.applied === 1 ? '' : 's'}; containers recreated.`,
      );
      return { applied: res.applied, restarted: res.restarted, health: res.health ?? null };
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

    async hasPendingCmsOperation(instanceId) {
      const client = new ComposeExecBackendOperationsClient({
        runner: deps.runner,
        instanceDir: instancePaths(instanceId, deps.root).dir,
        instanceId,
      });
      if ((await client.fetchPending(instanceId)) !== null) return true;
      // Managed-mode plugin installs/updates/uninstalls parked by the CMS for
      // the operator (the manager) count as pending work for the poller too.
      return hasPendingPluginOperations(deps, instanceId);
    },

    async drainCmsOperations(instanceId, ctx) {
      const client = new ComposeExecBackendOperationsClient({
        runner: deps.runner,
        instanceDir: instancePaths(instanceId, deps.root).dir,
        instanceId,
      });
      const outcomes = await drainInstanceOperations(deps, instanceId, client);
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
      // have reinstalled plugins as part of its own execution.
      const pluginReport = await drainInstancePluginOperations(deps, instanceId, { log: (l) => ctx.log(l) });
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
