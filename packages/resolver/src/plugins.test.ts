// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { PluginRelease, SecurityAdvisory } from '@shm/schemas';
import { evaluatePluginAgainstTargetCore, resolveLatestCompatiblePlugin } from './plugins.js';

function plugin(version: string, core: string, pluginApi = '^2.0', blocked = false): PluginRelease {
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
  it('selects the latest compatible version and explains the newer incompatible one', () => {
    const available = [
      plugin('2.4.0', '>=1.4.0 <2.0.0'),
      plugin('1.9.3', '>=1.2.0 <1.4.0'),
      plugin('1.3.0', '>=1.2.0 <1.4.0'),
    ];
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '1.2.0',
      pluginApiVersion: '2.0',
      available,
    });
    expect(r.selected?.version).toBe('1.9.3');
    expect(r.latest?.version).toBe('2.4.0');
    expect(r.newerExistsButIncompatible).toBe(true);
    expect(r.message).toMatch(/newer survey-js version \(2\.4\.0\)/);
  });

  it('returns null when nothing is compatible', () => {
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '1.0.0',
      pluginApiVersion: '2.0',
      available: [plugin('2.4.0', '>=1.4.0 <2.0.0')],
    });
    expect(r.selected).toBeNull();
    expect(r.message).toMatch(/No compatible/);
  });

  it('excludes advisory-blocked plugin versions', () => {
    const advisories: SecurityAdvisory[] = [
      {
        id: 'SHSA-2026-0001',
        severity: 'high',
        affected: [{ kind: 'plugin', id: 'survey-js', versions: '>=1.3.0 <1.3.2' }],
        fixed: [{ kind: 'plugin', id: 'survey-js', version: '1.3.2' }],
        recommendedAction: 'Update survey-js to 1.3.2.',
        blocked: true,
      },
    ];
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '1.2.0',
      pluginApiVersion: '2.0',
      available: [plugin('1.3.0', '>=1.2.0 <1.4.0'), plugin('1.3.2', '>=1.2.0 <1.4.0')],
      advisories,
    });
    expect(r.selected?.version).toBe('1.3.2');
  });
});

describe('official plugin resolves against the current 8.x core (version-scheme reconciliation)', () => {
  // The registry core release is 8.0.0 and the official SurveyJS plugin declares
  // compatibility selfhelp ">=8.0.0-dev <9.0.0". The two MUST resolve together,
  // i.e. the registry no longer mixes a 1.x core with an 8.x plugin range.
  const surveyJsOfficial = (): PluginRelease => ({
    kind: 'selfhelp-plugin-release',
    id: 'sh2-shp-survey-js',
    version: '0.2.20',
    channel: 'stable',
    official: true,
    compatibility: { core: '>=8.0.0-dev <9.0.0', pluginApi: '^2.0' },
    artifacts: { manifestUrl: 'm', archiveUrl: 'a', sha256: 'sha256:x' },
    security: { signature: 's', keyId: 'prod' },
    blocked: false,
  });

  it('resolves the official SurveyJS plugin against core 8.0.0', () => {
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '8.0.0',
      pluginApiVersion: '2.1',
      available: [surveyJsOfficial()],
    });
    expect(r.selected?.version).toBe('0.2.20');
    expect(r.message).toMatch(/compatible with SelfHelp 8\.0\.0/);
  });

  it('also resolves against the running 8.0.0-dev pre-release backend', () => {
    const r = resolveLatestCompatiblePlugin({
      coreVersion: '8.0.0-dev',
      pluginApiVersion: '2.1',
      available: [surveyJsOfficial()],
    });
    expect(r.selected?.version).toBe('0.2.20');
  });
});

describe('evaluatePluginAgainstTargetCore', () => {
  it('blocks when the installed plugin is incompatible with the target core', () => {
    const available = [plugin('1.3.0', '>=1.2.0 <1.4.0'), plugin('2.0.0', '>=1.5.0 <2.0.0')];
    const r = evaluatePluginAgainstTargetCore(
      { id: 'survey-js', version: '1.3.0' },
      '1.6.0',
      '2.2',
      available,
    );
    expect(r.blocked).toBe(true);
    expect(r.options.some((o) => o.type === 'update_plugin')).toBe(true);
    expect(r.message).toMatch(/not compatible with SelfHelp 1\.6\.0/);
  });

  it('allows when the installed plugin is compatible with the target core', () => {
    const available = [plugin('1.3.0', '>=1.2.0 <1.7.0')];
    const r = evaluatePluginAgainstTargetCore(
      { id: 'survey-js', version: '1.3.0' },
      '1.6.0',
      '2.2',
      available,
    );
    expect(r.blocked).toBe(false);
  });
});
