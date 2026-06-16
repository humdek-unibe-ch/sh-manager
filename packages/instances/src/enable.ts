// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Enable-instance (re-enable) planning — the inverse of the `disable` removal
 * mode.
 *
 * `disable` stops an instance's containers (`docker compose stop`) and marks the
 * inventory `disabled`, keeping every volume, secret, manifest and the inventory
 * entry. `remove_containers_keep_data` goes one step further (`docker compose
 * down`, status `removed_keep_data`) but also keeps all data. Both leave a fully
 * recoverable instance on disk — there was just no way to bring it back from the
 * manager, which is what this planner enables.
 *
 * `docker compose up -d` is the universal "bring it back" command: it starts the
 * stopped containers of a `disabled` instance and recreates the removed
 * containers of a `removed_keep_data` one. This is a pure planner: it validates
 * the request against the inventory and computes the safe compose command + the
 * resulting inventory mutation, refusing states that must not be auto-started.
 */
import type { InstanceStatus, ServerInventory } from '@shm/schemas';

/** Inventory statuses a stopped instance can be re-enabled from. */
export const ENABLEABLE_STATUSES: readonly InstanceStatus[] = ['disabled', 'removed_keep_data'];

export interface EnableRequest {
  instanceId: string;
}

export interface EnablePlan {
  ok: boolean;
  errors: string[];
  instanceId: string;
  composeProject: string;
  /** Safe `docker compose` arguments to run (always `up -d`; never `-v`). */
  composeArgs: string[];
  /** The status the instance is being recovered from, or null when unknown. */
  fromStatus: InstanceStatus | null;
  /** New inventory status after a successful enable (always `active`). */
  newStatus: InstanceStatus;
  /**
   * True when the instance was fully down (`removed_keep_data`) so `up -d`
   * recreates its containers (and composer-installed plugins must be remounted);
   * false when it was merely `disabled` (containers stopped, just started again).
   */
  recreated: boolean;
  steps: string[];
}

function emptyPlan(req: EnableRequest, composeProject: string, fromStatus: InstanceStatus | null, errors: string[]): EnablePlan {
  return {
    ok: false,
    errors,
    instanceId: req.instanceId,
    composeProject,
    composeArgs: [],
    fromStatus,
    newStatus: 'active',
    recreated: false,
    steps: [],
  };
}

/**
 * Builds the re-enable plan for one instance. Reads the compose project from the
 * inventory so the operation can never target a different instance's Docker
 * resources than the registered one, and refuses any status that must not be
 * blindly started (already `active`, mid-`installing`/`updating`, or `error`).
 */
export function planEnable(req: EnableRequest, inventory: ServerInventory): EnablePlan {
  const entry = inventory.instances.find((i) => i.instanceId === req.instanceId);
  if (!entry) {
    return emptyPlan(req, `selfhelp_${req.instanceId}`, null, [
      `Instance "${req.instanceId}" is not in the server inventory; refusing to start unknown Docker resources.`,
    ]);
  }

  const composeProject = entry.composeProject;

  if (entry.status === 'active') {
    return emptyPlan(req, composeProject, entry.status, [
      `Instance "${req.instanceId}" is already active; nothing to enable.`,
    ]);
  }

  if (!ENABLEABLE_STATUSES.includes(entry.status)) {
    return emptyPlan(req, composeProject, entry.status, [
      `Instance "${req.instanceId}" is "${entry.status}" and cannot be enabled. Only a disabled or removed-keep-data instance can be re-enabled.`,
    ]);
  }

  const recreated = entry.status === 'removed_keep_data';
  return {
    ok: true,
    errors: [],
    instanceId: req.instanceId,
    composeProject,
    composeArgs: ['up', '-d'],
    fromStatus: entry.status,
    newStatus: 'active',
    recreated,
    steps: [
      recreated
        ? `recreate containers for compose project "${composeProject}" (docker compose up -d)`
        : `start the stopped containers for compose project "${composeProject}" (docker compose up -d)`,
      'restore composer-installed plugins onto the (re)created containers (no-op when intact)',
      'mark inventory status as "active"',
    ],
  };
}
