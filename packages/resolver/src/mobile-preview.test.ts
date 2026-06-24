// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { CoreRelease, MobilePreviewRelease } from '@shm/schemas';
import {
  evaluateMobilePluginCompatibility,
  pickMobilePreviewForCore,
  resolveMobilePreviewUpdate,
  type InstalledPluginForMobileGate,
} from './core.js';

function core(version: string): CoreRelease {
  return {
    kind: 'selfhelp-core-release',
    id: 'selfhelp-core',
    version,
    channel: 'stable',
    releasedAt: '2026-06-23T10:00:00Z',
    minimumDirectUpgradeFrom: '0.1.0',
    pluginApiVersion: '0.1.0',
    backend: { image: 'b', digest: 'sha256:b' },
    worker: { image: 'w', digest: 'sha256:w' },
    scheduler: { image: 's', digest: 'sha256:s' },
    frontendCompatibility: { requiredFrontendRange: '>=0.1.0 <0.2.0' },
    database: { migrationRange: 'a-b', destructive: false, requiresBackup: true, manualConfirmationRequired: false },
    security: { signature: 's', keyId: 'humdek-2026-01' },
  };
}

function preview(
  version: string,
  opts: {
    requiredCoreRange?: string;
    channel?: MobilePreviewRelease['channel'];
    blocked?: boolean;
    rendererVersion?: string;
    reactNativeVersion?: string;
    expoSdkVersion?: string;
    bundled?: MobilePreviewRelease['bundledPlugins'];
  } = {},
): MobilePreviewRelease {
  return {
    kind: 'selfhelp-mobile-preview-release',
    id: `selfhelp-mobile-preview-${version}`,
    version,
    channel: opts.channel ?? 'stable',
    image: `ghcr.io/humdek-unibe-ch/selfhelp-mobile-preview:${version}`,
    digest: `sha256:${'a'.repeat(64)}`,
    backendCompatibility: { requiredCoreRange: opts.requiredCoreRange ?? '>=0.1.0 <0.2.0' },
    mobileRendererVersion: opts.rendererVersion ?? '0.1.0',
    reactNativeVersion: opts.reactNativeVersion ?? '0.83.0',
    expoSdkVersion: opts.expoSdkVersion ?? '55.0.0',
    bundledPlugins: opts.bundled ?? [],
    security: { signature: 's', keyId: 'humdek-2026-01' },
    ...(opts.blocked ? { blocked: true } : {}),
  };
}

describe('pickMobilePreviewForCore', () => {
  it('picks the newest non-blocked preview whose requiredCoreRange the core satisfies', () => {
    const chosen = pickMobilePreviewForCore(core('0.1.19'), [
      preview('0.1.0'),
      preview('0.2.0', { requiredCoreRange: '>=0.2.0 <0.3.0' }), // core 0.1.19 not in range
      preview('0.1.5'),
    ]);
    expect(chosen?.version).toBe('0.1.5');
  });

  it('returns null when no preview is compatible (instance simply runs no preview)', () => {
    expect(pickMobilePreviewForCore(core('0.1.19'), [preview('0.2.0', { requiredCoreRange: '>=0.2.0 <0.3.0' })])).toBeNull();
  });

  it('skips blocked previews', () => {
    const chosen = pickMobilePreviewForCore(core('0.1.19'), [preview('0.1.9', { blocked: true }), preview('0.1.3')]);
    expect(chosen?.version).toBe('0.1.3');
  });
});

describe('resolveMobilePreviewUpdate (preview-only update)', () => {
  const available = [preview('0.1.0'), preview('0.1.5'), preview('0.2.0', { requiredCoreRange: '>=0.2.0 <0.3.0' })];

  it('selects the newest compatible preview strictly newer than installed', () => {
    const r = resolveMobilePreviewUpdate({ currentMobilePreviewVersion: '0.1.0', coreVersion: '0.1.19', available });
    expect(r.status).toBe('ok');
    expect(r.selected?.version).toBe('0.1.5');
  });

  it('reports up_to_date when nothing newer is compatible', () => {
    const r = resolveMobilePreviewUpdate({ currentMobilePreviewVersion: '0.1.5', coreVersion: '0.1.19', available });
    expect(r.status).toBe('up_to_date');
  });

  it('blocks a target the running core cannot satisfy', () => {
    const r = resolveMobilePreviewUpdate({ currentMobilePreviewVersion: '0.1.0', coreVersion: '0.1.19', available, target: '0.2.0' });
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toMatch(/not compatible with SelfHelp core/);
  });

  it('blocks a downgrade', () => {
    const r = resolveMobilePreviewUpdate({ currentMobilePreviewVersion: '0.1.5', coreVersion: '0.1.19', available, target: '0.1.0' });
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toMatch(/downgrade/);
  });
});

describe('evaluateMobilePluginCompatibility (dual-axis plugin gate)', () => {
  const bundledSurvey = [
    { id: 'sh2-shp-survey-js', version: '0.2.23', mobilePackage: '@humdek/sh2-shp-survey-js-mobile', mobilePackageVersion: '0.2.23' },
  ];
  const img = preview('0.2.0', { rendererVersion: '0.1.0', bundled: bundledSurvey });

  it('marks a bundled, compatible plugin as native (status ok)', () => {
    const installed: InstalledPluginForMobileGate[] = [
      { id: 'sh2-shp-survey-js', version: '0.2.23', mobileCompatibility: '>=0.1.0 <0.2.0' },
    ];
    const r = evaluateMobilePluginCompatibility(img, installed);
    expect(r.status).toBe('ok');
    expect(r.evaluations[0]?.verdict).toBe('native');
  });

  it('blocks a plugin whose required renderer the image does not satisfy', () => {
    const installed: InstalledPluginForMobileGate[] = [
      { id: 'sh2-shp-survey-js', version: '0.2.23', mobileCompatibility: '>=0.2.0 <0.3.0' },
    ];
    const r = evaluateMobilePluginCompatibility(img, installed);
    expect(r.status).toBe('blocked');
    expect(r.blocked[0]?.verdict).toBe('incompatible');
  });

  it('blocks a plugin whose React Native range the image does not satisfy', () => {
    const installed: InstalledPluginForMobileGate[] = [
      {
        id: 'sh2-shp-survey-js',
        version: '0.2.23',
        mobileCompatibility: '>=0.1.0 <0.2.0',
        reactNativeCompatibility: '^0.84.0',
      },
    ];
    const r = evaluateMobilePluginCompatibility(img, installed);
    expect(r.status).toBe('blocked');
    expect(r.blocked[0]?.message).toMatch(/React Native/);
  });

  it('blocks a plugin whose Expo SDK range the image does not satisfy', () => {
    const installed: InstalledPluginForMobileGate[] = [
      {
        id: 'sh2-shp-survey-js',
        version: '0.2.23',
        mobileCompatibility: '>=0.1.0 <0.2.0',
        expoSdkCompatibility: '^56.0.0',
      },
    ];
    const r = evaluateMobilePluginCompatibility(img, installed);
    expect(r.status).toBe('blocked');
    expect(r.blocked[0]?.message).toMatch(/Expo SDK/);
  });

  it('blocks an RN/Expo-declaring plugin when the preview omits those versions (manual-path provenance gap)', () => {
    // Regression for the manual publish path that used to drop reactNativeVersion
    // / expoSdkVersion from the descriptor: a preview missing them cannot prove
    // a plugin's RN/Expo compatibility, so the gate BLOCKS (fail-closed). The
    // assemble-release builtFrom fallback keeps the fields populated so this
    // false block does not happen for real published previews.
    const previewMissingRuntime = { mobileRendererVersion: '0.1.0', bundledPlugins: [] };
    const installed: InstalledPluginForMobileGate[] = [
      {
        id: 'sh2-shp-survey-js',
        version: '0.2.23',
        mobileCompatibility: '>=0.1.0 <0.2.0',
        reactNativeCompatibility: '^0.83.0',
        expoSdkCompatibility: '^55.0.0',
      },
    ];
    const r = evaluateMobilePluginCompatibility(previewMissingRuntime, installed);
    expect(r.status).toBe('blocked');
    expect(r.blocked[0]?.message).toMatch(/unknown React Native version/);
  });

  it('renders native when the preview carries matching RN + Expo versions', () => {
    // The positive counterpart: with RN/Expo present and in range (the shape the
    // fixed publish paths always emit), a bundled compatible plugin is native.
    const installed: InstalledPluginForMobileGate[] = [
      {
        id: 'sh2-shp-survey-js',
        version: '0.2.23',
        mobileCompatibility: '>=0.1.0 <0.2.0',
        reactNativeCompatibility: '^0.83.0',
        expoSdkCompatibility: '^55.0.0',
      },
    ];
    const r = evaluateMobilePluginCompatibility(img, installed);
    expect(r.status).toBe('ok');
    expect(r.evaluations[0]?.verdict).toBe('native');
  });

  it('warns when a compatible plugin is not baked into the image (open-on-web fallback)', () => {
    const installed: InstalledPluginForMobileGate[] = [
      { id: 'acme-foreign-plugin', version: '1.0.0', mobileCompatibility: '>=0.1.0 <0.2.0' },
    ];
    const r = evaluateMobilePluginCompatibility(img, installed);
    expect(r.status).toBe('warning');
    expect(r.warnings[0]?.verdict).toBe('not_bundled');
  });

  it('warns on bundled-version drift but still renders native', () => {
    const installed: InstalledPluginForMobileGate[] = [
      { id: 'sh2-shp-survey-js', version: '0.2.20', mobileCompatibility: '>=0.1.0 <0.2.0' },
    ];
    const r = evaluateMobilePluginCompatibility(img, installed);
    expect(r.status).toBe('warning');
    expect(r.evaluations[0]?.verdict).toBe('native');
    expect(r.evaluations[0]?.bundledVersionDrift).toEqual({ bundled: '0.2.23', installed: '0.2.20' });
  });

  it('treats a plugin with no compatibility.mobile as web_only (info, status ok)', () => {
    const installed: InstalledPluginForMobileGate[] = [{ id: 'web-only-plugin', version: '1.0.0' }];
    const r = evaluateMobilePluginCompatibility(img, installed);
    expect(r.status).toBe('ok');
    expect(r.evaluations[0]?.verdict).toBe('web_only');
  });

  it('blocked wins over warning when both are present', () => {
    const installed: InstalledPluginForMobileGate[] = [
      { id: 'acme-foreign-plugin', version: '1.0.0', mobileCompatibility: '>=0.1.0 <0.2.0' }, // not bundled -> warn
      { id: 'sh2-shp-survey-js', version: '0.2.23', mobileCompatibility: '>=0.2.0 <0.3.0' }, // incompatible -> block
    ];
    const r = evaluateMobilePluginCompatibility(img, installed);
    expect(r.status).toBe('blocked');
    expect(r.blocked).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
  });
});
