// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import semver from 'semver';
import type {
  CoreRelease,
  FrontendRelease,
  MobilePreviewRelease,
  ReleaseChannel,
  SchedulerRelease,
  SecurityAdvisory,
  WorkerRelease,
} from '@shm/schemas';
import { isBlockedByAdvisory } from './advisories.js';
import { coerceVersion, satisfiesLoose } from './semver-util.js';

export interface CoreTargetInput {
  currentVersion: string;
  available: CoreRelease[];
  /** 'latest' picks the newest compatible non-blocked release; or a specific version. */
  target?: string;
  channel?: ReleaseChannel;
  advisories?: SecurityAdvisory[];
}

export interface CoreTargetResult {
  selected: CoreRelease | null;
  status: 'ok' | 'blocked' | 'up_to_date';
  reasons: string[];
}

export function canDirectUpgrade(currentVersion: string, release: CoreRelease): boolean {
  const cur = coerceVersion(currentVersion);
  const min = coerceVersion(release.minimumDirectUpgradeFrom);
  if (cur === null || min === null) return false;
  return semver.gte(cur, min);
}

export function resolveCoreTarget(input: CoreTargetInput): CoreTargetResult {
  const { currentVersion, available, target = 'latest', channel = 'stable', advisories = [] } = input;
  const reasons: string[] = [];

  const usable = available.filter((r) => {
    if (r.blocked) return false;
    if (r.channel !== channel) return false;
    if (isBlockedByAdvisory(advisories, 'core', r.version, r.id)) {
      reasons.push(`${r.version} is blocked by a security advisory.`);
      return false;
    }
    return true;
  });

  if (target !== 'latest') {
    const exact = usable.find((r) => coerceVersion(r.version) === coerceVersion(target));
    if (!exact) {
      const blockedByAdvisory = available.find(
        (r) => coerceVersion(r.version) === coerceVersion(target) && isBlockedByAdvisory(advisories, 'core', r.version, r.id),
      );
      return {
        selected: null,
        status: 'blocked',
        reasons: blockedByAdvisory
          ? [`SelfHelp ${target} is blocked by a security advisory.`]
          : [`SelfHelp ${target} is not available on the ${channel} channel.`],
      };
    }
    if (!canDirectUpgrade(currentVersion, exact)) {
      return {
        selected: null,
        status: 'blocked',
        reasons: [
          `Cannot upgrade directly from ${currentVersion} to ${exact.version} (minimum direct upgrade from ${exact.minimumDirectUpgradeFrom}).`,
        ],
      };
    }
    return { selected: exact, status: 'ok', reasons };
  }

  const sorted = [...usable].sort((a, b) =>
    semver.rcompare(coerceVersion(a.version) ?? '0.0.0', coerceVersion(b.version) ?? '0.0.0'),
  );

  const cur = coerceVersion(currentVersion);
  const newer = sorted.filter((r) => {
    const v = coerceVersion(r.version);
    return v !== null && cur !== null && semver.gt(v, cur);
  });

  if (newer.length === 0) {
    return { selected: null, status: 'up_to_date', reasons: [`SelfHelp ${currentVersion} is up to date.`] };
  }

  const directlyUpgradable = newer.find((r) => canDirectUpgrade(currentVersion, r));
  if (!directlyUpgradable) {
    return {
      selected: null,
      status: 'blocked',
      reasons: [
        `A newer SelfHelp version exists but cannot be reached directly from ${currentVersion}; upgrade to an intermediate version first.`,
      ],
    };
  }
  return { selected: directlyUpgradable, status: 'ok', reasons };
}

/** Picks a frontend release compatible with the chosen core release. */
export function pickFrontendForCore(
  core: CoreRelease,
  frontends: FrontendRelease[],
): FrontendRelease | null {
  const candidates = frontends.filter((f) => {
    if (f.blocked) return false;
    const frontendInRange = satisfiesLoose(f.version, core.frontendCompatibility.requiredFrontendRange);
    const coreInRange = satisfiesLoose(core.version, f.backendCompatibility.requiredCoreRange);
    return frontendInRange && coreInRange;
  });
  const sorted = candidates.sort((a, b) =>
    semver.rcompare(coerceVersion(a.version) ?? '0.0.0', coerceVersion(b.version) ?? '0.0.0'),
  );
  return sorted[0] ?? null;
}

export interface FrontendUpdateInput {
  /** The frontend version currently installed on the instance. */
  currentFrontendVersion: string;
  /** The instance's installed core version (unchanged by a frontend-only update). */
  coreVersion: string;
  /**
   * The current core release, when resolved from the registry. When present, its
   * `frontendCompatibility.requiredFrontendRange` is the running core's
   * frontend-compatibility constraint and is enforced, so a frontend-only update
   * never moves to a frontend the running core forbids.
   */
  currentCore?: CoreRelease | null;
  /**
   * The running core's required frontend range as recorded in the instance lock
   * at install/update time. This is the AUTHORITATIVE fallback when
   * {@link currentCore} is null because the core release has left the registry
   * index — it keeps the running core's constraint enforceable regardless.
   */
  currentCoreRequiredFrontendRange?: string | null;
  /**
   * Require the running core's frontend range to be known before allowing any
   * candidate. When true and neither {@link currentCore} nor
   * {@link currentCoreRequiredFrontendRange} provides it, every candidate is
   * BLOCKED (fail-closed): the running core's `requiredFrontendRange` must
   * always gate a frontend update, so an unknowable constraint stops the update
   * with operator guidance instead of silently allowing a possibly incompatible
   * frontend. Defaults to false so the pure resolver stays composable; the
   * instance frontend-update action sets it true.
   */
  requireCoreFrontendRange?: boolean;
  available: FrontendRelease[];
  /** 'latest' picks the newest compatible non-blocked frontend; or a specific version. */
  target?: string;
  channel?: ReleaseChannel;
  advisories?: SecurityAdvisory[];
}

export interface FrontendUpdateResult {
  selected: FrontendRelease | null;
  status: 'ok' | 'blocked' | 'up_to_date';
  reasons: string[];
}

/**
 * Resolve a FRONTEND-ONLY update: the newest compatible frontend that is
 * strictly newer than the one installed, leaving the core version untouched.
 *
 * The platform releases the frontend independently of the core (a new frontend
 * can target the same core range), so an instance on the latest core can still
 * have a newer frontend available. The core-driven {@link resolveCoreTarget}
 * never sees that case (it reports `up_to_date`), so this is the dedicated
 * resolver for it. Compatibility is enforced BOTH ways: the candidate must
 * accept the running core (`backendCompatibility.requiredCoreRange`) AND the
 * running core must accept the candidate (`frontendCompatibility.requiredFrontendRange`).
 * The running core's range comes from the live registry release when known,
 * otherwise from the value recorded in the instance lock — so it is enforced
 * even after the core release leaves the registry. With `requireCoreFrontendRange`
 * the resolver fails closed (blocks) when that range cannot be determined at all,
 * never silently dropping the constraint. Downgrades are blocked.
 */
export function resolveFrontendUpdate(input: FrontendUpdateInput): FrontendUpdateResult {
  const {
    currentFrontendVersion,
    coreVersion,
    currentCore = null,
    currentCoreRequiredFrontendRange = null,
    requireCoreFrontendRange = false,
    available,
    target = 'latest',
    channel = 'stable',
    advisories = [],
  } = input;
  const reasons: string[] = [];

  // The running core's required frontend range: prefer the live registry release,
  // fall back to the value persisted in the instance lock so the constraint
  // survives the core release leaving the registry index.
  const requiredFrontendRange: string | null =
    currentCore?.frontendCompatibility.requiredFrontendRange ?? currentCoreRequiredFrontendRange ?? null;

  // Fail closed: a frontend update must NEVER bypass the running core's
  // requiredFrontendRange. When it is required but cannot be determined (the
  // core release is gone from the registry AND the instance lock predates the
  // stored range), block with actionable guidance rather than allowing a
  // potentially incompatible frontend through.
  if (requireCoreFrontendRange && requiredFrontendRange === null) {
    return {
      selected: null,
      status: 'blocked',
      reasons: [
        `Cannot verify frontend compatibility: the running SelfHelp core ${coreVersion} is no longer in the ` +
          `registry and its required frontend range was not recorded for this instance. Update the core first ` +
          `(sh-manager instance update), then retry the frontend update.`,
      ],
    };
  }

  const isCompatible = (f: FrontendRelease): boolean => {
    if (f.blocked) return false;
    if (f.channel !== channel) return false;
    if (isBlockedByAdvisory(advisories, 'frontend', f.version, f.id)) {
      reasons.push(`Frontend ${f.version} is blocked by a security advisory.`);
      return false;
    }
    if (!satisfiesLoose(coreVersion, f.backendCompatibility.requiredCoreRange)) return false;
    if (requiredFrontendRange !== null && !satisfiesLoose(f.version, requiredFrontendRange)) {
      return false;
    }
    return true;
  };

  const cur = coerceVersion(currentFrontendVersion);

  if (target !== 'latest') {
    const wanted = coerceVersion(target);
    const exact = available.find((r) => coerceVersion(r.version) === wanted);
    if (!exact) {
      const blockedByAdvisory = available.find(
        (r) => coerceVersion(r.version) === wanted && isBlockedByAdvisory(advisories, 'frontend', r.version, r.id),
      );
      return {
        selected: null,
        status: 'blocked',
        reasons: blockedByAdvisory
          ? [`Frontend ${target} is blocked by a security advisory.`]
          : [`Frontend ${target} is not available on the ${channel} channel.`],
      };
    }
    if (cur !== null && wanted !== null && semver.eq(wanted, cur)) {
      return { selected: null, status: 'up_to_date', reasons: [`Frontend ${currentFrontendVersion} is up to date.`] };
    }
    if (cur !== null && wanted !== null && semver.lt(wanted, cur)) {
      return {
        selected: null,
        status: 'blocked',
        reasons: [`Frontend downgrade from ${currentFrontendVersion} to ${target} is not supported.`],
      };
    }
    if (!isCompatible(exact)) {
      // Distinguish WHICH side of the bidirectional check failed so the operator
      // knows the action: a frontend the running core forbids needs a core
      // upgrade first; the generic message covers the candidate-rejects-core and
      // advisory cases.
      const forbiddenByCore =
        requiredFrontendRange !== null && !satisfiesLoose(exact.version, requiredFrontendRange);
      return {
        selected: null,
        status: 'blocked',
        reasons: [
          forbiddenByCore
            ? `Frontend ${exact.version} is not accepted by the running SelfHelp core ${coreVersion} ` +
              `(required frontend range "${requiredFrontendRange}"). Update the core first, then retry the frontend update.`
            : `Frontend ${target} is not compatible with SelfHelp core ${coreVersion}.`,
        ],
      };
    }
    return { selected: exact, status: 'ok', reasons };
  }

  const newer = available
    .filter(isCompatible)
    .filter((f) => {
      const v = coerceVersion(f.version);
      return v !== null && cur !== null && semver.gt(v, cur);
    })
    .sort((a, b) => semver.rcompare(coerceVersion(a.version) ?? '0.0.0', coerceVersion(b.version) ?? '0.0.0'));

  if (newer.length === 0) {
    return { selected: null, status: 'up_to_date', reasons: [`Frontend ${currentFrontendVersion} is up to date.`] };
  }
  return { selected: newer[0]!, status: 'ok', reasons };
}

/**
 * Core-coupled service release (scheduler / worker): the same shape the picker
 * needs to resolve the newest non-blocked release whose `requiredCoreRange`
 * the chosen core version satisfies.
 */
interface CoreCoupledServiceRelease {
  version: string;
  blocked?: boolean;
  backendCompatibility: { requiredCoreRange: string };
}

function pickServiceForCore<T extends CoreCoupledServiceRelease>(core: CoreRelease, releases: T[]): T | null {
  const candidates = releases.filter(
    (r) => !r.blocked && satisfiesLoose(core.version, r.backendCompatibility.requiredCoreRange),
  );
  const sorted = candidates.sort((a, b) =>
    semver.rcompare(coerceVersion(a.version) ?? '0.0.0', coerceVersion(b.version) ?? '0.0.0'),
  );
  return sorted[0] ?? null;
}

/** Picks the newest scheduler release compatible with the chosen core release. */
export function pickSchedulerForCore(
  core: CoreRelease,
  schedulers: SchedulerRelease[],
): SchedulerRelease | null {
  return pickServiceForCore(core, schedulers);
}

/** Picks the newest worker release compatible with the chosen core release. */
export function pickWorkerForCore(core: CoreRelease, workers: WorkerRelease[]): WorkerRelease | null {
  return pickServiceForCore(core, workers);
}

/**
 * Picks the newest `selfhelp-mobile-preview` release compatible with the chosen
 * core release. The preview is OPTIONAL and core-coupled (it talks to the
 * private backend), so it resolves exactly like scheduler/worker. Returns null
 * when no compatible preview exists — install/update simply omits the service.
 */
export function pickMobilePreviewForCore(
  core: CoreRelease,
  previews: MobilePreviewRelease[],
): MobilePreviewRelease | null {
  return pickServiceForCore(core, previews);
}

export interface MobilePreviewUpdateInput {
  /** The mobile-preview version currently installed on the instance. */
  currentMobilePreviewVersion: string;
  /** The instance's installed core version (unchanged by a preview-only update). */
  coreVersion: string;
  available: MobilePreviewRelease[];
  /** 'latest' picks the newest compatible non-blocked preview; or a specific version. */
  target?: string;
  channel?: ReleaseChannel;
}

export interface MobilePreviewUpdateResult {
  selected: MobilePreviewRelease | null;
  status: 'ok' | 'blocked' | 'up_to_date';
  reasons: string[];
}

/**
 * Resolve a MOBILE-PREVIEW-ONLY update: the newest compatible preview image
 * strictly newer than the one installed, leaving the core untouched. The mobile
 * repo releases the preview image independently (on its own tags), so an
 * instance on the latest core can still have a newer preview available — the
 * core-driven resolver never sees that case. Compatibility is the running core
 * satisfying the candidate's `backendCompatibility.requiredCoreRange`. Mobile
 * preview is not a defined advisory `affected.kind`, so only the release
 * `blocked` flag + channel + core range gate here. Downgrades are blocked.
 */
export function resolveMobilePreviewUpdate(input: MobilePreviewUpdateInput): MobilePreviewUpdateResult {
  const {
    currentMobilePreviewVersion,
    coreVersion,
    available,
    target = 'latest',
    channel = 'stable',
  } = input;

  const isCompatible = (p: MobilePreviewRelease): boolean => {
    if (p.blocked) return false;
    if (p.channel !== channel) return false;
    return satisfiesLoose(coreVersion, p.backendCompatibility.requiredCoreRange);
  };

  const cur = coerceVersion(currentMobilePreviewVersion);

  if (target !== 'latest') {
    const wanted = coerceVersion(target);
    const exact = available.find((r) => coerceVersion(r.version) === wanted);
    if (!exact) {
      return {
        selected: null,
        status: 'blocked',
        reasons: [`Mobile preview ${target} is not available on the ${channel} channel.`],
      };
    }
    if (cur !== null && wanted !== null && semver.eq(wanted, cur)) {
      return { selected: null, status: 'up_to_date', reasons: [`Mobile preview ${currentMobilePreviewVersion} is up to date.`] };
    }
    if (cur !== null && wanted !== null && semver.lt(wanted, cur)) {
      return {
        selected: null,
        status: 'blocked',
        reasons: [`Mobile preview downgrade from ${currentMobilePreviewVersion} to ${target} is not supported.`],
      };
    }
    if (!isCompatible(exact)) {
      return {
        selected: null,
        status: 'blocked',
        reasons: [`Mobile preview ${target} is not compatible with SelfHelp core ${coreVersion}.`],
      };
    }
    return { selected: exact, status: 'ok', reasons: [] };
  }

  const newer = available
    .filter(isCompatible)
    .filter((p) => {
      const v = coerceVersion(p.version);
      return v !== null && cur !== null && semver.gt(v, cur);
    })
    .sort((a, b) => semver.rcompare(coerceVersion(a.version) ?? '0.0.0', coerceVersion(b.version) ?? '0.0.0'));

  if (newer.length === 0) {
    return { selected: null, status: 'up_to_date', reasons: [`Mobile preview ${currentMobilePreviewVersion} is up to date.`] };
  }
  return { selected: newer[0]!, status: 'ok', reasons: [] };
}

// ---------------------------------------------------------------------------
// Plugin <-> mobile-preview compatibility gate
// ---------------------------------------------------------------------------

/** Minimal installed-plugin shape the mobile gate needs. */
export interface InstalledPluginForMobileGate {
  id: string;
  version: string;
  /**
   * The plugin's declared mobile-renderer-contract range
   * (`compatibility.mobile`). Absent = the plugin ships no native mobile
   * renderer (web-only).
   */
  mobileCompatibility?: string | null;
  /** Plugin `compatibility.reactNative` range, when it ships a mobile package. */
  reactNativeCompatibility?: string | null;
  /** Plugin `compatibility.expoSdk` range, when it ships a mobile package. */
  expoSdkCompatibility?: string | null;
}

export type MobilePluginVerdict =
  /** Native renderer present, compatible, and baked into the preview image. */
  | 'native'
  /** Compatible renderer, but not in the curated image -> open-on-web fallback. */
  | 'not_bundled'
  /** Declares a native renderer the preview's contract does NOT satisfy. */
  | 'incompatible'
  /** No native renderer declared -> open-on-web by design. */
  | 'web_only';

export interface MobilePluginEvaluation {
  pluginId: string;
  pluginVersion: string;
  verdict: MobilePluginVerdict;
  /** Set for `native` when the bundled package version differs from installed. */
  bundledVersionDrift?: { bundled: string; installed: string };
  message: string;
}

export interface MobilePluginGateResult {
  /** Overall: blocked when ANY plugin is `incompatible`; warning when any is `not_bundled`/drift; else ok. */
  status: PreflightLikeStatus;
  evaluations: MobilePluginEvaluation[];
  blocked: MobilePluginEvaluation[];
  warnings: MobilePluginEvaluation[];
}

export type PreflightLikeStatus = 'ok' | 'warning' | 'blocked';

/**
 * Evaluate every installed plugin against a resolved `selfhelp-mobile-preview`
 * release. This powers the manager's "will this preview render my plugins?"
 * preflight (the dual-axis model the operator asked for):
 *
 * - A plugin that declares `compatibility.mobile`,
 *   `compatibility.reactNative`, or `compatibility.expoSdk` ranges the preview
 *   image does NOT satisfy is **blocked** (its native renderer would run against
 *   the wrong contract/runtime).
 * - A compatible plugin **baked into the image** renders natively (`native`),
 *   with a non-fatal **warning** when the bundled package version drifts from
 *   the installed plugin version.
 * - A compatible plugin **not** in the curated image is a **warning**
 *   (`not_bundled`): it falls back to open-on-web until a preview image bundles
 *   it; the preview is still usable.
 * - A plugin with no `compatibility.mobile` is **info** (`web_only`): the
 *   open-on-web deep link is the intended experience.
 *
 * Pure + deterministic; the CLI/BFF format the result.
 */
export function evaluateMobilePluginCompatibility(
  preview: Pick<MobilePreviewRelease, 'mobileRendererVersion' | 'reactNativeVersion' | 'expoSdkVersion' | 'bundledPlugins'>,
  installed: InstalledPluginForMobileGate[],
): MobilePluginGateResult {
  const bundledById = new Map(preview.bundledPlugins.map((b) => [b.id, b]));
  const evaluations: MobilePluginEvaluation[] = installed.map((plugin) => {
    const range = plugin.mobileCompatibility ?? null;
    if (range === null || range === '') {
      return {
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        verdict: 'web_only',
        message: `${plugin.id} has no native mobile renderer; it opens on the web frontend inside the preview.`,
      };
    }
    if (!satisfiesLoose(preview.mobileRendererVersion, range)) {
      return {
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        verdict: 'incompatible',
        message:
          `${plugin.id} requires mobile renderer "${range}" but the preview image ships ` +
          `${preview.mobileRendererVersion}; update the mobile preview (or the plugin) first.`,
      };
    }
    if (
      plugin.reactNativeCompatibility &&
      (!preview.reactNativeVersion || !satisfiesLoose(preview.reactNativeVersion, plugin.reactNativeCompatibility))
    ) {
      return {
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        verdict: 'incompatible',
        message:
          `${plugin.id} requires React Native "${plugin.reactNativeCompatibility}" but the preview image ships ` +
          `${preview.reactNativeVersion ?? 'an unknown React Native version'}; update the mobile preview first.`,
      };
    }
    if (
      plugin.expoSdkCompatibility &&
      (!preview.expoSdkVersion || !satisfiesLoose(preview.expoSdkVersion, plugin.expoSdkCompatibility))
    ) {
      return {
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        verdict: 'incompatible',
        message:
          `${plugin.id} requires Expo SDK "${plugin.expoSdkCompatibility}" but the preview image ships ` +
          `${preview.expoSdkVersion ?? 'an unknown Expo SDK version'}; update the mobile preview first.`,
      };
    }
    const bundled = bundledById.get(plugin.id);
    if (!bundled) {
      return {
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        verdict: 'not_bundled',
        message:
          `${plugin.id} has a compatible native renderer but is not baked into this preview image; ` +
          `it falls back to open-on-web until a preview bundling it is published.`,
      };
    }
    const drift =
      coerceVersion(bundled.version) !== coerceVersion(plugin.version)
        ? { bundled: bundled.version, installed: plugin.version }
        : undefined;
    return {
      pluginId: plugin.id,
      pluginVersion: plugin.version,
      verdict: 'native',
      ...(drift ? { bundledVersionDrift: drift } : {}),
      message: drift
        ? `${plugin.id} renders natively, but the preview bundles ${bundled.version} while ${plugin.version} is installed (version drift).`
        : `${plugin.id} renders natively in the preview.`,
    };
  });

  const blocked = evaluations.filter((e) => e.verdict === 'incompatible');
  const warnings = evaluations.filter((e) => e.verdict === 'not_bundled' || e.bundledVersionDrift !== undefined);
  const status: PreflightLikeStatus = blocked.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'ok';
  return { status, evaluations, blocked, warnings };
}
