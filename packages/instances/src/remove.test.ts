// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { ServerInventory } from '@shm/schemas';
import { planRemove } from './remove.js';

const ROOT = '/opt/selfhelp';

function inventory(...ids: string[]): ServerInventory {
  return {
    inventoryVersion: 1,
    serverId: 's1',
    manager: { name: 'SelfHelp Manager', repository: 'sh-manager', version: '0.1.0' },
    proxy: { type: 'traefik', network: 'selfhelp_proxy', composePath: '/opt/selfhelp/proxy/compose.yaml' },
    instances: ids.map((id) => ({
      instanceId: id,
      domain: `${id}.example.ch`,
      path: `/opt/selfhelp/instances/${id}`,
      composeProject: `selfhelp_${id}`,
      status: 'active',
    })),
  };
}

describe('planRemove', () => {
  it('disable stops containers, keeps data, and marks the inventory disabled', () => {
    const plan = planRemove({ instanceId: 'website1', mode: 'disable' }, inventory('website1', 'website2'), ROOT);
    expect(plan.ok).toBe(true);
    expect(plan.composeArgs).toEqual(['stop']);
    expect(plan.newStatus).toBe('disabled');
    expect(plan.removeInventoryEntry).toBe(false);
    expect(plan.deleteVolumes).toEqual([]);
    expect(plan.deleteInstanceDir).toBe(false);
  });

  it('remove_containers_keep_data downs the project without -v and keeps volumes', () => {
    const plan = planRemove({ instanceId: 'website1', mode: 'remove_containers_keep_data' }, inventory('website1'), ROOT);
    expect(plan.ok).toBe(true);
    expect(plan.composeArgs).toEqual(['down']);
    expect(plan.composeArgs).not.toContain('-v');
    expect(plan.newStatus).toBe('removed_keep_data');
    expect(plan.deleteVolumes).toEqual([]);
    expect(plan.deleteInstanceDir).toBe(false);
  });

  it('full_delete is blocked without the exact typed confirmation', () => {
    const plan = planRemove({ instanceId: 'website1', mode: 'full_delete' }, inventory('website1'), ROOT);
    expect(plan.ok).toBe(false);
    expect(plan.errors.join(' ')).toContain('delete website1');
    expect(plan.removeInventoryEntry).toBe(false);
  });

  it('full_delete with confirmation removes the entry and (opt-in) the volumes', () => {
    const plan = planRemove(
      { instanceId: 'website1', mode: 'full_delete', deleteVolumes: true, typedConfirmation: 'delete website1' },
      inventory('website1', 'website2'),
      ROOT,
    );
    expect(plan.ok).toBe(true);
    expect(plan.composeArgs).toEqual(['down']);
    expect(plan.removeInventoryEntry).toBe(true);
    expect(plan.newStatus).toBeNull();
    expect(plan.deleteInstanceDir).toBe(true);
    expect(plan.preserveBackups).toBe(true);
    expect(plan.deleteVolumes).toEqual([
      'selfhelp_website1_mysql_data',
      'selfhelp_website1_uploads',
      'selfhelp_website1_plugin_artifacts',
    ]);
  });

  it('full_delete keeps volumes unless the operator opts in, and can delete backups', () => {
    const plan = planRemove(
      { instanceId: 'website1', mode: 'full_delete', deleteBackups: true, typedConfirmation: 'delete website1' },
      inventory('website1'),
      ROOT,
    );
    expect(plan.ok).toBe(true);
    expect(plan.deleteVolumes).toEqual([]);
    expect(plan.preserveBackups).toBe(false);
  });

  it('refuses to remove an instance that is not in the inventory', () => {
    const plan = planRemove({ instanceId: 'ghost', mode: 'disable' }, inventory('website1'), ROOT);
    expect(plan.ok).toBe(false);
    expect(plan.errors.join(' ')).toContain('not in the server inventory');
  });

  it('refuses destructive removal when the compose project is shared', () => {
    const inv = inventory('website1');
    inv.instances.push({
      instanceId: 'website2',
      domain: 'website2.example.ch',
      path: '/opt/selfhelp/instances/website2',
      composeProject: 'selfhelp_website1', // deliberately shared
      status: 'active',
    });
    const plan = planRemove({ instanceId: 'website1', mode: 'full_delete', typedConfirmation: 'delete website1' }, inv, ROOT);
    expect(plan.ok).toBe(false);
    expect(plan.errors.join(' ')).toContain('shared');
  });
});
