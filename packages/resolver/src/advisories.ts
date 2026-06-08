// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { SecurityAdvisory } from '@shm/schemas';
import { satisfiesLoose } from './semver-util.js';

export interface AdvisoryMatch {
  advisory: SecurityAdvisory;
  blocked: boolean;
}

/**
 * Returns advisories that affect the given component+version. `blocked`
 * advisories must refuse install/update in production unless an explicit
 * override policy is added later.
 */
export function advisoriesFor(
  advisories: SecurityAdvisory[],
  component: 'core' | 'frontend' | 'plugin',
  version: string,
  id?: string,
): AdvisoryMatch[] {
  const out: AdvisoryMatch[] = [];
  for (const advisory of advisories) {
    const hit = advisory.affected.some((a) => {
      if (a.kind !== component) return false;
      if (component === 'plugin' && a.id !== id) return false;
      return satisfiesLoose(version, a.versions);
    });
    if (hit) out.push({ advisory, blocked: advisory.blocked });
  }
  return out;
}

export function isBlockedByAdvisory(
  advisories: SecurityAdvisory[],
  component: 'core' | 'frontend' | 'plugin',
  version: string,
  id?: string,
): boolean {
  return advisoriesFor(advisories, component, version, id).some((m) => m.blocked);
}
