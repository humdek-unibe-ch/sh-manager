// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { InstanceStatus, ServerInventory } from '@shm/schemas';
import { planEnable } from './enable.js';

function inventory(entries: { id: string; status: InstanceStatus }[]): ServerInventory {
  return {
    inventoryVersion: 1,
    serverId: 's1',
    manager: { name: 'SelfHelp Manager', repository: 'sh-manager', version: '0.1.0' },
    proxy: { type: 'traefik', network: 'selfhelp_proxy', composePath: '/opt/selfhelp/proxy/compose.yaml' },
    instances: entries.map((e) => ({
      instanceId: e.id,
      domain: `${e.id}.example.ch`,
      path: `/opt/selfhelp/instances/${e.id}`,
      composeProject: `selfhelp_${e.id}`,
      status: e.status,
    })),
  };
}

describe('planEnable', () => {
  it('re-enables a disabled instance by starting its containers and marking it active', () => {
    const plan = planEnable({ instanceId: 'website1' }, inventory([{ id: 'website1', status: 'disabled' }]));
    expect(plan.ok).toBe(true);
    expect(plan.composeArgs).toEqual(['up', '-d']);
    expect(plan.newStatus).toBe('active');
    expect(plan.fromStatus).toBe('disabled');
    // A disabled instance only had its containers STOPPED, so up -d starts them
    // (no recreate → plugins are already mounted).
    expect(plan.recreated).toBe(false);
  });

  it('re-enables a removed-keep-data instance and flags that containers are recreated', () => {
    const plan = planEnable({ instanceId: 'website1' }, inventory([{ id: 'website1', status: 'removed_keep_data' }]));
    expect(plan.ok).toBe(true);
    expect(plan.composeArgs).toEqual(['up', '-d']);
    expect(plan.newStatus).toBe('active');
    // down → up recreates containers, so plugins must be remounted afterwards.
    expect(plan.recreated).toBe(true);
  });

  it('refuses to enable an instance that is already active', () => {
    const plan = planEnable({ instanceId: 'website1' }, inventory([{ id: 'website1', status: 'active' }]));
    expect(plan.ok).toBe(false);
    expect(plan.composeArgs).toEqual([]);
    expect(plan.errors.join(' ')).toContain('already active');
  });

  it('refuses to enable a transient/broken state (installing/updating/error)', () => {
    for (const status of ['installing', 'updating', 'error'] as InstanceStatus[]) {
      const plan = planEnable({ instanceId: 'website1' }, inventory([{ id: 'website1', status }]));
      expect(plan.ok).toBe(false);
      expect(plan.errors.join(' ')).toContain('cannot be enabled');
    }
  });

  it('refuses to enable an instance that is not in the inventory', () => {
    const plan = planEnable({ instanceId: 'ghost' }, inventory([{ id: 'website1', status: 'disabled' }]));
    expect(plan.ok).toBe(false);
    expect(plan.errors.join(' ')).toContain('not in the server inventory');
  });
});
