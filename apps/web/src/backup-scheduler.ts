// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Background scheduled-backup loop for the PERSISTENT manager web server.
 *
 * Every tick (default 60s) it walks the inventory and, for each active
 * instance whose `backupSchedule` says a nightly backup is due, runs the
 * backup + GFS prune through the shared {@link OperationRunner} — journaled,
 * audit-logged, and serialized against GUI actions and the CMS poller via the
 * same per-instance lock. The dueness peek is a cheap read so idle ticks never
 * create journal rows.
 *
 * The headless equivalent is `sh-manager server run-scheduled-backups` from
 * cron / a systemd timer (see deploy/). Both paths share the same per-instance
 * run + state file, so an occurrence is only ever covered once.
 */
import { InstanceLockedError, type OperationRunner } from './jobs.js';
import { isPollable, type ManagerInstanceActions } from './instances.js';

export interface BackupSchedulerLoopOptions {
  instances: ManagerInstanceActions;
  runner: OperationRunner;
  /** Tick interval; default 60s. */
  intervalMs?: number;
  /** Sink for operational chatter (default console). */
  log?: (line: string) => void;
}

export class BackupSchedulerLoop {
  private readonly instances: ManagerInstanceActions;
  private readonly runner: OperationRunner;
  private readonly intervalMs: number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  /** Last error message per instance, to log each distinct failure once. */
  private readonly lastError = new Map<string, string>();

  constructor(opts: BackupSchedulerLoopOptions) {
    this.instances = opts.instances;
    this.runner = opts.runner;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Node should be able to exit even with the scheduler armed.
    this.timer.unref?.();
    this.log(`Backup scheduler started (checks every ${Math.round(this.intervalMs / 1000)}s).`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // An in-flight backup finishes naturally; it must never be interrupted.
  }

  /** One scheduler pass. Public so tests (and a "run now" hook) can call it. */
  async tick(): Promise<void> {
    if (this.ticking) return; // never overlap passes
    this.ticking = true;
    try {
      const summaries = await this.instances.list();
      for (const summary of summaries) {
        if (this.stopped) break;
        if (!isPollable(summary)) continue; // skip broken/disabled/busy
        await this.runInstance(summary.instanceId);
      }
    } catch (err) {
      this.logOnce('*', `Backup scheduler pass failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async runInstance(instanceId: string): Promise<void> {
    let due = false;
    try {
      due = await this.instances.hasDueScheduledBackup(instanceId);
      this.lastError.delete(instanceId);
    } catch (err) {
      this.logOnce(instanceId, `Backup-due check for ${instanceId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!due) return;

    try {
      const { done } = await this.runner.start(
        { kind: 'instance_scheduled_backup', instanceId, operator: 'system (backup scheduler)', sourceIp: null },
        (ctx) => this.instances.runScheduledBackup(instanceId, ctx),
      );
      // Serialize within the pass: backups are IO-heavy; one at a time keeps
      // the disk/database pressure bounded on multi-instance servers.
      await done;
      this.log(`Scheduled backup for ${instanceId} completed.`);
    } catch (err) {
      if (err instanceof InstanceLockedError) return; // GUI/poller action in flight — next tick retries
      this.logOnce(instanceId, `Scheduled backup for ${instanceId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private logOnce(key: string, message: string): void {
    if (this.lastError.get(key) === message) return;
    this.lastError.set(key, message);
    this.log(message);
  }
}
