// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import semver from 'semver';
import type { PluginRelease, SecurityAdvisory } from '@shm/schemas';
import { isBlockedByAdvisory } from './advisories.js';
import { coerceVersion, satisfiesLoose } from './semver-util.js';

export interface PluginResolutionInput {
  coreVersion: string;
  pluginApiVersion: string;
  available: PluginRelease[];
  advisories?: SecurityAdvisory[];
}

export interface PluginResolution {
  pluginId: string;
  selected: PluginRelease | null;
  latest: PluginRelease | null;
  /** True when a newer version exists but is incompatible with the core. */
  newerExistsButIncompatible: boolean;
  message: string;
}

export function isPluginCompatible(
  release: PluginRelease,
  coreVersion: string,
  pluginApiVersion: string,
  advisories: SecurityAdvisory[] = [],
): boolean {
  if (release.blocked) return false;
  if (isBlockedByAdvisory(advisories, 'plugin', release.version, release.id)) return false;
  return (
    satisfiesLoose(coreVersion, release.compatibility.core) &&
    satisfiesLoose(pluginApiVersion, release.compatibility.pluginApi)
  );
}

/**
 * Selects the latest plugin version compatible with the installed core, and
 * explains when a newer-but-incompatible version exists (the plan's
 * "you can install survey-js 1.9.3" message).
 */
export function resolveLatestCompatiblePlugin(input: PluginResolutionInput): PluginResolution {
  const { coreVersion, pluginApiVersion, available, advisories = [] } = input;
  const pluginId = available[0]?.id ?? 'unknown';

  const sorted = [...available].sort((a, b) => {
    const av = coerceVersion(a.version) ?? '0.0.0';
    const bv = coerceVersion(b.version) ?? '0.0.0';
    return semver.rcompare(av, bv);
  });

  const latest = sorted[0] ?? null;
  const selected =
    sorted.find((r) => isPluginCompatible(r, coreVersion, pluginApiVersion, advisories)) ?? null;

  const newerExistsButIncompatible =
    latest !== null && selected !== null && latest.version !== selected.version;

  let message: string;
  if (selected === null) {
    message = `No compatible ${pluginId} version found for SelfHelp ${coreVersion}.`;
  } else if (newerExistsButIncompatible && latest) {
    message =
      `A newer ${pluginId} version (${latest.version}) exists, but it requires ` +
      `SelfHelp ${latest.compatibility.core}. You can install ${pluginId} ${selected.version}, ` +
      `which is compatible with your current SelfHelp version.`;
  } else {
    message = `${pluginId} ${selected.version} is compatible with SelfHelp ${coreVersion}.`;
  }

  return { pluginId, selected, latest, newerExistsButIncompatible, message };
}

export interface PluginUpdateBlock {
  blocked: boolean;
  message: string;
  options: { type: string; value: string; label: string }[];
}

/**
 * Evaluates whether keeping an installed plugin is safe when moving core to
 * `targetCoreVersion` (the plan's "Update blocked" path).
 */
export function evaluatePluginAgainstTargetCore(
  installed: { id: string; version: string },
  targetCoreVersion: string,
  pluginApiVersion: string,
  available: PluginRelease[],
  advisories: SecurityAdvisory[] = [],
): PluginUpdateBlock {
  const installedRelease = available.find(
    (r) => r.id === installed.id && r.version === installed.version,
  );
  const compatibleAtTarget =
    installedRelease !== undefined &&
    isPluginCompatible(installedRelease, targetCoreVersion, pluginApiVersion, advisories);

  if (compatibleAtTarget) {
    return { blocked: false, message: `${installed.id} ${installed.version} is compatible.`, options: [] };
  }

  const upgrade = resolveLatestCompatiblePlugin({
    coreVersion: targetCoreVersion,
    pluginApiVersion,
    available,
    advisories,
  });

  const options: { type: string; value: string; label: string }[] = [];
  if (upgrade.selected) {
    options.push({
      type: 'update_plugin',
      value: upgrade.selected.version,
      label: `Update ${installed.id} to ${upgrade.selected.version} first`,
    });
  }
  options.push({ type: 'keep_current', value: installed.version, label: 'Keep current version' });

  return {
    blocked: true,
    message: `${installed.id} ${installed.version} is not compatible with SelfHelp ${targetCoreVersion}.`,
    options,
  };
}
