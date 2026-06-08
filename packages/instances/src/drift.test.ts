// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { ServerInventory } from '@shm/schemas';
import { assertNoBlockingDrift, detectInventoryDrift, InventoryDriftError } from './drift.js';

function inv(instances: ServerInventory['instances']): ServerInventory {
  return {
    inventoryVersion: 1,
    serverId: 'server-001',
    manager: { name: 'SelfHelp Manager', repository: 'sh-manager', version: '0.1.0' },
    proxy: { type: 'traefik', network: 'selfhelp_proxy', composePath: '/opt/selfhelp/proxy/compose.yaml' },
    instances,
  };
}

const entry = (instanceId: string, domain: string) => ({
  instanceId,
  domain,
  path: `/opt/selfhelp/instances/${instanceId}`,
  composeProject: `selfhelp_${instanceId}`,
  status: 'active' as const,
});

describe('detectInventoryDrift', () => {
  it('reports no drift when inventory matches disk', () => {
    const drift = detectInventoryDrift(inv([entry('a', 'a.example.ch')]), ['a']);
    expect(drift.hasDrift).toBe(false);
  });

  it('flags unmanaged dirs and missing dirs', () => {
    const drift = detectInventoryDrift(inv([entry('a', 'a.example.ch')]), ['b']);
    expect(drift.unmanagedOnDisk).toEqual(['b']);
    expect(drift.missingOnDisk).toEqual(['a']);
    expect(() => assertNoBlockingDrift(drift)).toThrow(InventoryDriftError);
  });

  it('flags duplicate domains', () => {
    const drift = detectInventoryDrift(
      inv([entry('a', 'dup.example.ch'), entry('b', 'dup.example.ch')]),
      ['a', 'b'],
    );
    expect(drift.duplicateDomains).toEqual(['dup.example.ch']);
    expect(drift.hasDrift).toBe(true);
  });
});
