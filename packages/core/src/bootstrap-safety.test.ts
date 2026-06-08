// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  BootstrapConflictError,
  assertSafeToBootstrap,
  assessBootstrapTarget,
} from './bootstrap-safety.js';

describe('assessBootstrapTarget', () => {
  it('treats an empty target as clean', () => {
    const a = assessBootstrapTarget({ inventoryExists: false, proxyComposeExists: false, instanceDirsOnDisk: [] });
    expect(a.decision).toBe('clean');
    expect(a.findings).toEqual([]);
  });

  it('treats an inventory as an already-managed server', () => {
    const a = assessBootstrapTarget({ inventoryExists: true, proxyComposeExists: true, instanceDirsOnDisk: ['website1'] });
    expect(a.decision).toBe('existing-managed');
    expect(a.findings.join(' ')).toMatch(/inventory/);
  });

  it('treats artifacts without an inventory as a conflict (partial/foreign install)', () => {
    const a = assessBootstrapTarget({
      inventoryExists: false,
      proxyComposeExists: true,
      instanceDirsOnDisk: [],
      dockerVolumes: ['website1_db'],
    });
    expect(a.decision).toBe('conflict');
    expect(a.findings.join(' ')).toMatch(/proxy compose|volume/);
  });
});

describe('assertSafeToBootstrap', () => {
  it('passes for a clean target', () => {
    expect(() =>
      assertSafeToBootstrap(assessBootstrapTarget({ inventoryExists: false, proxyComposeExists: false, instanceDirsOnDisk: [] })),
    ).not.toThrow();
  });

  it('blocks an already-managed server', () => {
    expect(() =>
      assertSafeToBootstrap(assessBootstrapTarget({ inventoryExists: true, proxyComposeExists: false, instanceDirsOnDisk: [] })),
    ).toThrow(BootstrapConflictError);
  });

  it('blocks a conflicting target', () => {
    expect(() =>
      assertSafeToBootstrap(assessBootstrapTarget({ inventoryExists: false, proxyComposeExists: true, instanceDirsOnDisk: [] })),
    ).toThrow(BootstrapConflictError);
  });

  it('allows re-bootstrap when import is explicitly acknowledged', () => {
    expect(() =>
      assertSafeToBootstrap(
        assessBootstrapTarget({ inventoryExists: true, proxyComposeExists: true, instanceDirsOnDisk: ['website1'] }),
        { allowImport: true },
      ),
    ).not.toThrow();
  });
});
