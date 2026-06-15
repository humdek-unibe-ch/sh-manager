// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import semver from 'semver';
import type {
  CoreRelease,
  FrontendRelease,
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
  target?: 'latest' | string;
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
   * The current core release, when known. When present, its
   * `frontendCompatibility.requiredFrontendRange` is enforced too, so a
   * frontend-only update never moves to a frontend the running core forbids.
   */
  currentCore?: CoreRelease | null;
  available: FrontendRelease[];
  /** 'latest' picks the newest compatible non-blocked frontend; or a specific version. */
  target?: 'latest' | string;
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
 * resolver for it. Compatibility is enforced both ways: the candidate must
 * accept the running core (`backendCompatibility.requiredCoreRange`) and, when
 * the current core release is known, the running core must accept the candidate
 * (`frontendCompatibility.requiredFrontendRange`). Downgrades are blocked.
 */
export function resolveFrontendUpdate(input: FrontendUpdateInput): FrontendUpdateResult {
  const {
    currentFrontendVersion,
    coreVersion,
    currentCore = null,
    available,
    target = 'latest',
    channel = 'stable',
    advisories = [],
  } = input;
  const reasons: string[] = [];

  const isCompatible = (f: FrontendRelease): boolean => {
    if (f.blocked) return false;
    if (f.channel !== channel) return false;
    if (isBlockedByAdvisory(advisories, 'frontend', f.version, f.id)) {
      reasons.push(`Frontend ${f.version} is blocked by a security advisory.`);
      return false;
    }
    if (!satisfiesLoose(coreVersion, f.backendCompatibility.requiredCoreRange)) return false;
    if (currentCore && !satisfiesLoose(f.version, currentCore.frontendCompatibility.requiredFrontendRange)) {
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
      return {
        selected: null,
        status: 'blocked',
        reasons: [`Frontend ${target} is not compatible with SelfHelp core ${coreVersion}.`],
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
