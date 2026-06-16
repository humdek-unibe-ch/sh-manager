// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Background CMS-operations poller for the PERSISTENT manager web server.
 *
 * This closes the "request an update in the CMS and nothing happens" gap:
 * every tick it walks the inventory, peeks each active instance's backend for
 * a pending CMS-requested operation (cheap exec-transport read), and drains
 * the queue through the shared {@link OperationRunner} — so each drain is
 * journaled, audit-logged, and serialized against GUI actions via the same
 * per-instance lock. The headless equivalent stays
 * `sh-manager instance process-operations <id> --watch`.
 */
import { InstanceLockedError, type OperationRunner } from './jobs.js';
import { isPollable, type ManagerInstanceActions, type PendingCmsWork } from './instances.js';

export interface CmsOperationsPollerOptions {
  instances: ManagerInstanceActions;
  runner: OperationRunner;
  /** Tick interval; default 15s. */
  intervalMs?: number;
  /** Sink for operational chatter (default console). */
  log?: (line: string) => void;
}

export class CmsOperationsPoller {
  private readonly instances: ManagerInstanceActions;
  private readonly runner: OperationRunner;
  private readonly intervalMs: number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  /** Last error message per instance, to log each distinct failure once. */
  private readonly lastError = new Map<string, string>();

  constructor(opts: CmsOperationsPollerOptions) {
    this.instances = opts.instances;
    this.runner = opts.runner;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Node should be able to exit even with the poller armed.
    this.timer.unref?.();
    this.log(`CMS operations poller started (every ${Math.round(this.intervalMs / 1000)}s).`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight tick finish naturally; ticks are short except while an
    // update runs, and those must never be interrupted mid-flight anyway.
  }

  /** One poll pass. Public so tests (and a future "drain now" button) can call it. */
  async tick(): Promise<void> {
    if (this.ticking) return; // never overlap passes
    this.ticking = true;
    try {
      const summaries = await this.instances.list();
      for (const summary of summaries) {
        if (this.stopped) break;
        if (!isPollable(summary)) continue;
        await this.pollInstance(summary.instanceId);
      }
    } catch (err) {
      this.logOnce('*', `CMS poller pass failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async pollInstance(instanceId: string): Promise<void> {
    let work: PendingCmsWork;
    try {
      work = await this.instances.peekPendingCmsWork(instanceId);
      this.lastError.delete(instanceId);
    } catch (err) {
      // Backend down / token missing / legacy instance: log each distinct
      // problem once instead of every 15s, and keep polling the others.
      this.logOnce(instanceId, `CMS poll for ${instanceId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!work.systemUpdate && !work.pluginOps) return;

    // Journal a CMS-requested core/frontend update under its REAL kind so the
    // operation history reads "instance core update" / "instance frontend
    // update" with the matching live step checklist — not the opaque
    // "Plugin / CMS operation" drain (which stays for plugin-only work).
    const kind =
      work.systemUpdate === 'frontend'
        ? 'instance_frontend_update'
        : work.systemUpdate === 'core'
          ? 'instance_update'
          : 'cms_operations_drain';

    try {
      const { done } = await this.runner.start(
        { kind, instanceId, operator: 'system (cms poller)', sourceIp: null },
        (ctx) => this.instances.drainCmsOperations(instanceId, ctx),
      );
      // Serialize within the pass: an update can take minutes and the next
      // tick skips busy instances anyway, but finishing here keeps log order
      // sane and avoids hammering Docker with parallel heavy operations.
      await done;
      this.log(`Drained CMS operations for ${instanceId}.`);
    } catch (err) {
      if (err instanceof InstanceLockedError) return; // GUI action in flight — next tick retries
      this.logOnce(instanceId, `CMS drain for ${instanceId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private logOnce(key: string, message: string): void {
    if (this.lastError.get(key) === message) return;
    this.lastError.set(key, message);
    this.log(message);
  }
}
