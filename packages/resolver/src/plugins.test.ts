// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { PluginRelease, SecurityAdvisory } from '@shm/schemas';
import { evaluatePluginAgainstTargetCore, resolveLatestCompatiblePlugin } from './plugins.js';

// Reconciled pre-release ecosystem: every axis starts at 0.1.0 and, per SemVer,
// each pre-1.0 MINOR is breaking. The registry therefore carries one plugin
// release per compatible core minor, e.g.:
//   survey-js 0.1.0  ->  >=0.1.0 <0.2.0
//   survey-js 0.2.0  ->  >=0.2.0 <0.3.0
//   survey-js 0.3.0  ->  >=0.3.0 <0.4.0
function plugin(version: string, core: string, pluginApi = '0.1.0', blocked = false): PluginRelease {
  return {
    kind: 'selfhelp-plugin-release',
    id: 'survey-js',
    version,
    channel: 'stable',
    official: true,
    compatibility: { core, pluginApi },
    artifacts: { manifestUrl: 'm', archiveUrl: 'a', sha256: 'sha256:x' },
    security: { signature: 's', keyId: 'humdek-2026-01' },
    blocked,
  };
}

describe('resolveLatestCompatiblePlugin', () => {
  it('selects the newest compatible version and explains the newer incompatible one', () => {
    const available = [
      plugin('0.3.0', '>=0.3.0 <0.4.0'),
      plugin('0.2.0', '>=0.2.0 <0.3.0'),
      plugin('0.1.0', '>=0.1.0 <0.2.0'),
    ];
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '0.2.0',
      pluginApiVersion: '0.1.0',
      available,
    });
    expect(r.selected?.version).toBe('0.2.0');
    expect(r.latest?.version).toBe('0.3.0');
    expect(r.newerExistsButIncompatible).toBe(true);
    expect(r.message).toMatch(/newer survey-js version \(0\.3\.0\)/);
  });

  it('returns null when nothing is compatible', () => {
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '0.5.0',
      pluginApiVersion: '0.1.0',
      available: [plugin('0.3.0', '>=0.3.0 <0.4.0')],
    });
    expect(r.selected).toBeNull();
    expect(r.message).toMatch(/No compatible/);
  });

  it('excludes advisory-blocked plugin versions', () => {
    const advisories: SecurityAdvisory[] = [
      {
        id: 'SHSA-2026-0001',
        severity: 'high',
        affected: [{ kind: 'plugin', id: 'survey-js', versions: '>=0.2.0 <0.2.2' }],
        fixed: [{ kind: 'plugin', id: 'survey-js', version: '0.2.2' }],
        recommendedAction: 'Update survey-js to 0.2.2.',
        blocked: true,
      },
    ];
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '0.2.0',
      pluginApiVersion: '0.1.0',
      available: [plugin('0.2.0', '>=0.2.0 <0.3.0'), plugin('0.2.2', '>=0.2.0 <0.3.0')],
      advisories,
    });
    expect(r.selected?.version).toBe('0.2.2');
  });
});

describe('official plugin resolves against the reconciled 0.1.x core', () => {
  // The registry core release is 0.1.0 and the official SurveyJS plugin declares
  // compatibility selfhelp ">=0.1.0 <0.2.0" + pluginApi "0.1.0". The two MUST
  // resolve together — the registry never mixes core and plugin version axes.
  const surveyJsOfficial = (): PluginRelease => ({
    kind: 'selfhelp-plugin-release',
    id: 'sh2-shp-survey-js',
    version: '0.1.0',
    channel: 'stable',
    official: true,
    compatibility: { core: '>=0.1.0 <0.2.0', pluginApi: '0.1.0' },
    artifacts: { manifestUrl: 'm', archiveUrl: 'a', sha256: 'sha256:x' },
    security: { signature: 's', keyId: 'prod' },
    blocked: false,
  });

  it('resolves the official SurveyJS plugin against core 0.1.0', () => {
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '0.1.0',
      pluginApiVersion: '0.1.0',
      available: [surveyJsOfficial()],
    });
    expect(r.selected?.version).toBe('0.1.0');
    expect(r.message).toMatch(/compatible with SelfHelp 0\.1\.0/);
  });

  it('also resolves against a 0.1.x core patch backend', () => {
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '0.1.5',
      pluginApiVersion: '0.1.0',
      available: [surveyJsOfficial()],
    });
    expect(r.selected?.version).toBe('0.1.0');
  });
});

describe('evaluatePluginAgainstTargetCore (core-update preflight)', () => {
  it('lets a compatible plugin survive a core update (core patch within range)', () => {
    // survey-js 0.1.0 declares >=0.1.0 <0.2.0; a core PATCH to 0.1.5 stays in range.
    const available = [plugin('0.1.0', '>=0.1.0 <0.2.0')];
    const r = evaluatePluginAgainstTargetCore(
      { id: 'survey-js', version: '0.1.0' },
      '0.1.5',
      '0.1.0',
      available,
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks a core MINOR update when the installed plugin is incompatible, and offers the newer compatible version', () => {
    const available = [plugin('0.1.0', '>=0.1.0 <0.2.0'), plugin('0.2.0', '>=0.2.0 <0.3.0')];
    const r = evaluatePluginAgainstTargetCore(
      { id: 'survey-js', version: '0.1.0' },
      '0.2.0',
      '0.1.0',
      available,
    );
    expect(r.blocked).toBe(true);
    const updateOption = r.options.find((o) => o.type === 'update_plugin');
    expect(updateOption?.value).toBe('0.2.0');
    expect(r.message).toMatch(/not compatible with SelfHelp 0\.2\.0/);
  });

  it('keeps a pinned older-but-compatible plugin valid across a core patch', () => {
    // Even though 0.1.5 of the plugin exists, the pinned 0.1.0 stays compatible
    // with the 0.1.9 core, so the update is not blocked and nothing is forced.
    const available = [plugin('0.1.0', '>=0.1.0 <0.2.0'), plugin('0.1.5', '>=0.1.0 <0.2.0')];
    const r = evaluatePluginAgainstTargetCore(
      { id: 'survey-js', version: '0.1.0' },
      '0.1.9',
      '0.1.0',
      available,
    );
    expect(r.blocked).toBe(false);
    expect(r.options).toHaveLength(0);
  });
});
