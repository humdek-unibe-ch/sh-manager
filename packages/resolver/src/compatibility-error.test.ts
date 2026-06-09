// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Standardized compatibility-error SHAPE parity (#53 / #49).
 *
 * The compatibility error is a cross-repo contract: the SAME object is rendered
 * by the backend (`CompatibilityError::toArray()`), the shared SDK
 * (`@selfhelp/shared` `ICompatibilityError`), the frontend
 * (`IPluginCompatibilityError`), and the SelfHelp Manager (`@shm/resolver`
 * `CompatibilityError`). An operator must see the SAME fields no matter which
 * installer raised it. This test pins the canonical field set and proves the
 * Manager resolver emits exactly that shape when a plugin blocks a core update.
 */
import { describe, expect, it } from 'vitest';
import type { PluginRelease } from '@shm/schemas';
import { evaluatePluginAgainstTargetCore, type CompatibilityError } from './plugins.js';

/** The exact keys `CompatibilityError::toArray()` (backend) emits. Snake_case wire contract. */
const CANONICAL_KEYS = [
  'blocking',
  'component',
  'component_id',
  'current_version',
  'message',
  'required_range',
  'target_version',
] as const;

function plugin(version: string, core: string, pluginApi = '0.1.0'): PluginRelease {
  return {
    kind: 'selfhelp-plugin-release',
    id: 'survey-js',
    version,
    channel: 'stable',
    official: true,
    compatibility: { core, pluginApi },
    artifacts: { manifestUrl: 'm', archiveUrl: 'a', sha256: 'sha256:x' },
    security: { signature: 's', keyId: 'humdek-2026-01' },
    blocked: false,
  };
}

describe('compatibility-error shape parity (manager mirrors backend/shared/frontend)', () => {
  it('the CompatibilityError type carries exactly the canonical keys', () => {
    // Typed literal: `tsc` rejects any added/renamed/removed field, so this can
    // only compile while the Manager type matches the cross-repo contract.
    const error: CompatibilityError = {
      component: 'plugin',
      component_id: 'survey-js',
      current_version: '0.1.0',
      target_version: '0.2.0',
      required_range: '>=0.1.0 <0.2.0',
      blocking: true,
      message: 'incompatible',
    };
    expect(Object.keys(error).sort()).toEqual([...CANONICAL_KEYS]);
  });

  it('emits null when the installed plugin is compatible with the target core', () => {
    const available = [plugin('0.2.0', '>=0.2.0 <0.3.0')];
    const block = evaluatePluginAgainstTargetCore(
      { id: 'survey-js', version: '0.2.0' },
      '0.2.0',
      '0.1.0',
      available,
    );
    expect(block.blocked).toBe(false);
    expect(block.compatibilityError).toBeNull();
  });

  it('emits the canonical compatibility error when a plugin blocks a core update', () => {
    // Installed survey-js 0.1.0 requires core >=0.1.0 <0.2.0; moving core to 0.2.0
    // is blocked. A newer compatible plugin (0.2.0) exists -> target_version set.
    const available = [plugin('0.2.0', '>=0.2.0 <0.3.0'), plugin('0.1.0', '>=0.1.0 <0.2.0')];
    const block = evaluatePluginAgainstTargetCore(
      { id: 'survey-js', version: '0.1.0' },
      '0.2.0',
      '0.1.0',
      available,
    );

    expect(block.blocked).toBe(true);
    const err = block.compatibilityError;
    expect(err).not.toBeNull();
    expect(Object.keys(err ?? {}).sort()).toEqual([...CANONICAL_KEYS]);
    expect(err?.component).toBe('plugin');
    expect(err?.component_id).toBe('survey-js');
    expect(err?.current_version).toBe('0.1.0');
    expect(err?.target_version).toBe('0.2.0');
    expect(err?.required_range).toBe('>=0.1.0 <0.2.0');
    expect(err?.blocking).toBe(true);
  });
});
