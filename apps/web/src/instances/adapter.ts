// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Real adapter over the shared application-service layer (@shm/app-actions):
 * the GUI seam {@link buildInstanceActions} that the BFF + pollers drive. Split
 * out of `instances.ts` so the public interface/request types stay in one file
 * and the ~560-line wrapper lives here. Mutating ops run inside an
 * OperationRunner body and report through the {@link OperationContext}.
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BackupManifest, InstanceManifest, ServerInventory } from '@shm/schemas';
import { InventoryStore, ManifestStore, instancePaths } from '@shm/instances';
import {
  describePluginOperation,
  drainInstanceOperations,
  drainInstancePluginOperations,
  hasPendingPluginOperations,
  cleanupInstanceOrphans,
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
  instanceRemove,
  instanceRestore,
  instanceRunScheduledBackup,
  scanInstanceOrphans,
  instanceSetAddress,
  instanceSetEnv,
  instanceSetMailer,
  instanceSetName,
  instanceUpdate,
  instanceFrontendUpdate,
  serverInit,
  serverProxyLogs,
  ComposeExecBackendOperationsClient,
  type InstanceFrontendUpdateOptions,
  type InstanceInstallOptions,
  type InstanceUpdateOptions,
  type PluginRecoverResult,
} from '@shm/app-actions';
import type { OperationContext } from '../jobs.js';
import { cmsUpdatePhaseStep } from './cms-phase.js';
import type {
  InstanceSummary,
  PendingCmsWork,
  BackupSummary,
  ManagerInstanceActions,
  BuildInstanceActionsOptions,
} from '../instances.js';

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

    async scanOrphans(instanceId) {
      return scanInstanceOrphans(deps, instanceId);
    },

    async cleanupOrphans(instanceId) {
      return cleanupInstanceOrphans(deps, instanceId);
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
        // One-off notices (e.g. reclaiming a stale volume from a previous
        // install of this id) stream into the operation log without moving the
        // checklist marker.
        log: (line) => ctx.log(line),
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
