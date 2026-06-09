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

/**
 * The standardized compatibility-error object, shared verbatim across the
 * SelfHelp stack so an operator sees identical compat info regardless of which
 * installer raised it:
 *   - backend `App\Plugin\Registry\Unified\CompatibilityError::toArray()`,
 *   - shared `@selfhelp/shared` `ICompatibilityError`,
 *   - frontend `IPluginCompatibilityError`.
 * Snake_case is the cross-repo wire contract; the field set MUST match the others
 * (enforced by the parity tests on both sides).
 */
export interface CompatibilityError {
  component: 'core' | 'frontend' | 'plugin';
  component_id: string;
  current_version: string | null;
  target_version: string | null;
  required_range: string;
  blocking: boolean;
  message: string;
}

export interface PluginUpdateBlock {
  blocked: boolean;
  message: string;
  options: { type: string; value: string; label: string }[];
  /**
   * The standardized compatibility error when `blocked` is true (the installed
   * plugin does not admit the target core), or null when compatible. Same shape
   * as the backend/shared/frontend so the core-update preflight and the plugin
   * install/update render identical compat info.
   */
  compatibilityError: CompatibilityError | null;
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
    return {
      blocked: false,
      message: `${installed.id} ${installed.version} is compatible.`,
      options: [],
      compatibilityError: null,
    };
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

  // The installed plugin blocks the core update: surface the standardized
  // compatibility error (same shape the backend/frontend use). `required_range`
  // is the core range the installed plugin declares; `target_version` is the
  // version it would need to be updated to (when a compatible one exists).
  const requiredRange = installedRelease?.compatibility.core ?? '*';
  const compatibilityError: CompatibilityError = {
    component: 'plugin',
    component_id: installed.id,
    current_version: installed.version,
    target_version: upgrade.selected?.version ?? null,
    required_range: requiredRange,
    blocking: true,
    message:
      `${installed.id} ${installed.version} requires SelfHelp ${requiredRange} and is not compatible ` +
      `with SelfHelp ${targetCoreVersion}.`,
  };

  return {
    blocked: true,
    message: `${installed.id} ${installed.version} is not compatible with SelfHelp ${targetCoreVersion}.`,
    options,
    compatibilityError,
  };
}
