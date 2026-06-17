// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Orphaned-resource discovery + cleanup for an instance id that is NOT (or no
 * longer) registered on this server.
 *
 * Removing an instance with `full_delete` but WITHOUT its volumes (or an orphan
 * left by an older manager / an aborted install) deletes the instance directory
 * and the inventory entry, but leaves the persistent Docker volumes
 * (`<project>_mysql_data`, `_uploads`, `_plugin_artifacts*`) behind. Their
 * matching secrets are gone, so MySQL — which only applies credentials to an
 * EMPTY data volume — can never authenticate against them again: reinstalling
 * the same id used to die at `wait_db` with "Access denied".
 *
 * {@link scanInstanceOrphans} lets the create-instance wizard SURFACE that
 * leftover state before the operator installs, and {@link cleanupInstanceOrphans}
 * removes it on request ("remove it") — the explicit, audited counterpart to the
 * install-time auto-reclaim ("overwrite it"). Both refuse to touch a REGISTERED
 * instance's data: that path is the audited `instance remove`, never this one.
 */
import { rm } from 'node:fs/promises';
import { InventoryStore, instancePaths } from '@shm/instances';
import { instanceDataVolumes, pathExists, type ActionDeps } from './shared.js';

export interface InstanceOrphanReport {
  instanceId: string;
  /** True when the id is a registered instance (its data is live — never an orphan). */
  registered: boolean;
  /** Leftover persistent Docker volumes (`<project>_*`) that still exist on the host. */
  volumes: string[];
  /** True when an instance directory still exists on disk for this id. */
  hasDirectory: boolean;
  /** True when there is leftover state to clean up AND the id is not a live instance. */
  hasOrphans: boolean;
}

export interface CleanupOrphansResult {
  removedVolumes: string[];
  removedDirectory: boolean;
}

/** Is this id currently listed in the server inventory? */
async function isRegistered(deps: ActionDeps, instanceId: string): Promise<boolean> {
  return new InventoryStore(deps.root)
    .read()
    .then((inv) => inv.instances.some((i) => i.instanceId === instanceId))
    .catch(() => false);
}

/**
 * Reports the leftover Docker volumes / instance directory for an id that is not
 * a registered instance. A registered instance is never reported as orphaned —
 * its volumes and directory are live data. No-op for volumes when the
 * `volumeExists` host helper is unavailable (offline/CLI test deps).
 */
export async function scanInstanceOrphans(deps: ActionDeps, instanceId: string): Promise<InstanceOrphanReport> {
  const registered = await isRegistered(deps, instanceId);
  const hasDirectory = await pathExists(instancePaths(instanceId, deps.root).dir);

  // A live instance is never "orphaned" — its volumes/dir are its own data, so
  // don't even probe Docker for it (and the wizard's duplicate-id rule handles
  // reusing an existing id at submit).
  if (registered) return { instanceId, registered: true, volumes: [], hasDirectory, hasOrphans: false };

  const volumes: string[] = [];
  if (deps.volumeExists) {
    for (const name of instanceDataVolumes(instanceId)) {
      if (await deps.volumeExists(name)) volumes.push(name);
    }
  }

  const hasOrphans = volumes.length > 0 || hasDirectory;
  return { instanceId, registered, volumes, hasDirectory, hasOrphans };
}

/**
 * Removes the orphaned Docker volumes (and the leftover instance directory, if
 * any) for an id that is NOT a registered instance — the explicit "remove it"
 * action behind the wizard's orphan warning.
 *
 * Hard guard: it refuses to run for a registered instance, so it can never
 * delete a live instance's database/uploads through this unaudited path (that is
 * what `instance remove --mode full_delete --delete-volumes` is for). Throws
 * when there are volumes to remove but no `removeVolumes` host helper is wired.
 */
export async function cleanupInstanceOrphans(
  deps: ActionDeps,
  instanceId: string,
  log?: (line: string) => void | Promise<void>,
): Promise<CleanupOrphansResult> {
  const report = await scanInstanceOrphans(deps, instanceId);
  if (report.registered) {
    throw new Error(
      `"${instanceId}" is a registered instance — refusing to delete its data here. ` +
        `Use "Remove instance" (full delete, including volumes) instead.`,
    );
  }

  const removedVolumes: string[] = [];
  if (report.volumes.length > 0) {
    if (!deps.removeVolumes) throw new Error('removeVolumes host helper is not available.');
    await log?.(`Removing ${report.volumes.length} orphaned Docker volume(s): ${report.volumes.join(', ')}.`);
    await deps.removeVolumes(report.volumes);
    removedVolumes.push(...report.volumes);
  }

  let removedDirectory = false;
  if (report.hasDirectory) {
    const dir = instancePaths(instanceId, deps.root).dir;
    await log?.(`Removing orphaned instance directory ${dir}.`);
    await rm(dir, { recursive: true, force: true });
    removedDirectory = true;
  }

  return { removedVolumes, removedDirectory };
}
