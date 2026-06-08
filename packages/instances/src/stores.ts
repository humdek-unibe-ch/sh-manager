// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Validated, schema-gated, atomic stores for the server inventory and the
 * per-instance manifest + lock files.
 */
import {
  assertSchemaCompatible,
  validateInstanceLock,
  validateInstanceManifest,
  validateServerInventory,
  type InstanceLock,
  type InstanceManifest,
  type ServerInventory,
} from '@shm/schemas';
import { readJson, writeJsonAtomic } from './atomic.js';
import { instancePaths, serverInventoryPath, type InstancePaths } from './paths.js';

export class StoreValidationError extends Error {
  constructor(
    message: string,
    readonly errors: string[],
  ) {
    super(`${message}: ${errors.join('; ')}`);
    this.name = 'StoreValidationError';
  }
}

export class InventoryStore {
  constructor(private readonly root: string) {}

  get path(): string {
    return serverInventoryPath(this.root);
  }

  async read(): Promise<ServerInventory> {
    const data = await readJson(this.path);
    assertSchemaCompatible('inventory', (data as { inventoryVersion?: unknown }).inventoryVersion);
    const v = validateServerInventory(data);
    if (!v.valid || !v.value) throw new StoreValidationError('Invalid server inventory', v.errors);
    return v.value;
  }

  async write(inventory: ServerInventory): Promise<void> {
    const v = validateServerInventory(inventory);
    if (!v.valid) throw new StoreValidationError('Refusing to write invalid inventory', v.errors);
    await writeJsonAtomic(this.path, inventory);
  }

  async upsertInstance(
    entry: ServerInventory['instances'][number],
    base?: ServerInventory,
  ): Promise<ServerInventory> {
    const inventory = base ?? (await this.read());
    const idx = inventory.instances.findIndex((i) => i.instanceId === entry.instanceId);
    if (idx >= 0) inventory.instances[idx] = entry;
    else inventory.instances.push(entry);
    await this.write(inventory);
    return inventory;
  }
}

export class ManifestStore {
  private readonly paths: InstancePaths;
  constructor(instanceId: string, root: string) {
    this.paths = instancePaths(instanceId, root);
  }

  get path(): string {
    return this.paths.manifestPath;
  }

  async read(): Promise<InstanceManifest> {
    const data = await readJson(this.path);
    assertSchemaCompatible('manifest', (data as { manifestVersion?: unknown }).manifestVersion);
    const v = validateInstanceManifest(data);
    if (!v.valid || !v.value) throw new StoreValidationError('Invalid instance manifest', v.errors);
    return v.value;
  }

  async write(manifest: InstanceManifest): Promise<void> {
    const v = validateInstanceManifest(manifest);
    if (!v.valid) throw new StoreValidationError('Refusing to write invalid manifest', v.errors);
    await writeJsonAtomic(this.path, manifest);
  }
}

export class LockStore {
  private readonly paths: InstancePaths;
  constructor(instanceId: string, root: string) {
    this.paths = instancePaths(instanceId, root);
  }

  get path(): string {
    return this.paths.lockPath;
  }

  async read(): Promise<InstanceLock> {
    const data = await readJson(this.path);
    assertSchemaCompatible('lock', (data as { lockfileVersion?: unknown }).lockfileVersion);
    const v = validateInstanceLock(data);
    if (!v.valid || !v.value) throw new StoreValidationError('Invalid instance lock', v.errors);
    return v.value;
  }

  async write(lock: InstanceLock): Promise<void> {
    const v = validateInstanceLock(lock);
    if (!v.valid) throw new StoreValidationError('Refusing to write invalid lock', v.errors);
    await writeJsonAtomic(this.path, lock);
  }
}
