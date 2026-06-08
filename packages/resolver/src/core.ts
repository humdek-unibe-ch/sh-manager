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
