// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Drift detection between the server inventory and what exists on disk.
 * Destructive operations are forbidden until drift is resolved/imported.
 */
import type { ServerInventory } from '@shm/schemas';

export interface InventoryDrift {
  hasDrift: boolean;
  /** Instance dirs found on disk but absent from the inventory. */
  unmanagedOnDisk: string[];
  /** Inventory entries with no matching instance dir on disk. */
  missingOnDisk: string[];
  /** Domains assigned to more than one instance. */
  duplicateDomains: string[];
}

export function detectDuplicateDomains(inventory: ServerInventory): string[] {
  const seen = new Map<string, number>();
  for (const i of inventory.instances) {
    seen.set(i.domain, (seen.get(i.domain) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([d]) => d);
}

export function detectInventoryDrift(
  inventory: ServerInventory,
  discoveredInstanceIds: string[],
): InventoryDrift {
  const inInventory = new Set(inventory.instances.map((i) => i.instanceId));
  const onDisk = new Set(discoveredInstanceIds);

  const unmanagedOnDisk = discoveredInstanceIds.filter((id) => !inInventory.has(id));
  const missingOnDisk = inventory.instances
    .map((i) => i.instanceId)
    .filter((id) => !onDisk.has(id));
  const duplicateDomains = detectDuplicateDomains(inventory);

  return {
    hasDrift: unmanagedOnDisk.length > 0 || missingOnDisk.length > 0 || duplicateDomains.length > 0,
    unmanagedOnDisk,
    missingOnDisk,
    duplicateDomains,
  };
}

export class InventoryDriftError extends Error {
  constructor(readonly drift: InventoryDrift) {
    super(
      'Server inventory drift detected; destructive operations are blocked until repair/import. ' +
        `unmanaged=[${drift.unmanagedOnDisk.join(',')}] missing=[${drift.missingOnDisk.join(',')}] ` +
        `duplicateDomains=[${drift.duplicateDomains.join(',')}]`,
    );
    this.name = 'InventoryDriftError';
  }
}

/** Throws when drift would make a destructive operation unsafe. */
export function assertNoBlockingDrift(drift: InventoryDrift): void {
  if (drift.hasDrift) throw new InventoryDriftError(drift);
}
