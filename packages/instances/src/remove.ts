// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Remove-instance planning.
 *
 * Removing one instance must never touch another instance and must never remove
 * the shared Traefik proxy while other instances still exist. The three modes
 * map to the distribution plan:
 *
 * - `disable`                    -> stop containers, keep everything, status `disabled`.
 * - `remove_containers_keep_data`-> `docker compose down` (no `-v`), keep volumes/
 *                                    backups, status `removed_keep_data`.
 * - `full_delete`                -> requires a typed confirmation; `down` then delete
 *                                    this instance's named volumes/folder, drop the
 *                                    inventory entry. Backups are kept unless the
 *                                    operator explicitly opts in.
 *
 * This is a pure planner: it computes the safe command + volume/dir lists and the
 * resulting inventory mutation, and refuses unsafe requests by returning errors.
 * The CLI action executes the plan.
 */
import type { InstanceStatus, ServerInventory } from '@shm/schemas';
import { instancePaths } from './paths.js';

export type RemoveMode = 'disable' | 'remove_containers_keep_data' | 'full_delete';

export interface RemoveRequest {
  instanceId: string;
  mode: RemoveMode;
  /** full_delete only: also delete this instance's persistent Docker volumes. */
  deleteVolumes?: boolean;
  /** full_delete only: also delete this instance's backups directory. */
  deleteBackups?: boolean;
  /** full_delete only: must equal `delete <instanceId>`. */
  typedConfirmation?: string;
}

export interface RemovePlan {
  ok: boolean;
  errors: string[];
  instanceId: string;
  mode: RemoveMode;
  composeProject: string;
  /** Safe `docker compose` arguments to run (never includes `-v`). */
  composeArgs: string[];
  /** New inventory status, or `null` when the entry is removed entirely. */
  newStatus: InstanceStatus | null;
  removeInventoryEntry: boolean;
  /** Named Docker volumes to delete (full_delete + deleteVolumes only). */
  deleteVolumes: string[];
  /** Whether the instance directory should be removed (full_delete only). */
  deleteInstanceDir: boolean;
  /** When deleting the instance dir, keep the backups subdirectory. */
  preserveBackups: boolean;
  steps: string[];
}

function emptyPlan(req: RemoveRequest, composeProject: string, errors: string[]): RemovePlan {
  return {
    ok: false,
    errors,
    instanceId: req.instanceId,
    mode: req.mode,
    composeProject,
    composeArgs: [],
    newStatus: null,
    removeInventoryEntry: false,
    deleteVolumes: [],
    deleteInstanceDir: false,
    preserveBackups: true,
    steps: [],
  };
}

/**
 * Builds the removal plan for one instance. Reads the compose project + path from
 * the inventory so the operation can never target a different instance's Docker
 * resources than the registered ones.
 */
export function planRemove(req: RemoveRequest, inventory: ServerInventory, root: string): RemovePlan {
  const entry = inventory.instances.find((i) => i.instanceId === req.instanceId);
  if (!entry) {
    return emptyPlan(req, `selfhelp_${req.instanceId}`, [
      `Instance "${req.instanceId}" is not in the server inventory; refusing to remove unknown Docker resources.`,
    ]);
  }

  const composeProject = entry.composeProject;

  // Defensive: a shared compose project would mean removing it could affect
  // another instance. Each instance must own a unique compose project.
  const sharers = inventory.instances.filter(
    (i) => i.composeProject === composeProject && i.instanceId !== req.instanceId,
  );
  if (sharers.length > 0) {
    return emptyPlan(req, composeProject, [
      `Compose project "${composeProject}" is shared with: ${sharers.map((s) => s.instanceId).join(', ')}. Refusing destructive removal.`,
    ]);
  }

  if (req.mode === 'disable') {
    return {
      ok: true,
      errors: [],
      instanceId: req.instanceId,
      mode: req.mode,
      composeProject,
      composeArgs: ['stop'],
      newStatus: 'disabled',
      removeInventoryEntry: false,
      deleteVolumes: [],
      deleteInstanceDir: false,
      preserveBackups: true,
      steps: [
        `stop containers for compose project "${composeProject}"`,
        'keep compose files, volumes, backups, manifest, lock, and inventory entry',
        'mark inventory status as "disabled"',
      ],
    };
  }

  if (req.mode === 'remove_containers_keep_data') {
    return {
      ok: true,
      errors: [],
      instanceId: req.instanceId,
      mode: req.mode,
      composeProject,
      composeArgs: ['down'],
      newStatus: 'removed_keep_data',
      removeInventoryEntry: false,
      deleteVolumes: [],
      deleteInstanceDir: false,
      preserveBackups: true,
      steps: [
        `remove containers + networks for "${composeProject}" (docker compose down, no -v)`,
        'keep DB/uploads/plugin volumes, backups, manifest, lock, and the instance folder',
        'mark inventory status as "removed_keep_data"',
      ],
    };
  }

  // full_delete
  const errors: string[] = [];
  const expected = `delete ${req.instanceId}`;
  if (req.typedConfirmation !== expected) {
    errors.push(`Full delete requires typed confirmation: "${expected}".`);
  }
  if (errors.length > 0) {
    return emptyPlan(req, composeProject, errors);
  }

  const deleteVolumes = req.deleteVolumes
    ? [
        `${composeProject}_mysql_data`,
        `${composeProject}_uploads`,
        `${composeProject}_plugin_artifacts`,
        `${composeProject}_plugin_artifacts_public`,
      ]
    : [];
  const preserveBackups = req.deleteBackups !== true;

  const steps = [
    `remove containers + networks for "${composeProject}" (docker compose down, no -v)`,
  ];
  if (deleteVolumes.length > 0) steps.push(`delete instance volumes: ${deleteVolumes.join(', ')}`);
  else steps.push('keep instance volumes (operator did not opt into volume deletion)');
  steps.push(preserveBackups ? `delete instance folder but keep ${instancePaths(req.instanceId, root).backupsDir}` : 'delete instance folder including backups');
  steps.push('remove the inventory entry');
  steps.push('never remove the shared Traefik proxy');

  return {
    ok: true,
    errors: [],
    instanceId: req.instanceId,
    mode: req.mode,
    composeProject,
    composeArgs: ['down'],
    newStatus: null,
    removeInventoryEntry: true,
    deleteVolumes,
    deleteInstanceDir: true,
    preserveBackups,
    steps,
  };
}
