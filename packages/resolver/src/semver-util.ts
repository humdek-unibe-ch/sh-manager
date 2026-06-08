// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import semver from 'semver';

/** Coerces a loose version (e.g. plugin API "2.1") to a full semver. */
export function coerceVersion(value: string): string | null {
  if (semver.valid(value)) return value;
  return semver.coerce(value)?.version ?? null;
}

/** Coerces a loose range so "^2.0" / "2.1" work against coerced versions. */
export function satisfiesLoose(version: string, range: string): boolean {
  const v = coerceVersion(version);
  if (v === null) return false;
  if (semver.validRange(range)) {
    return semver.satisfies(v, range, { includePrerelease: true });
  }
  const coercedRange = semver.coerce(range)?.version;
  if (coercedRange && semver.validRange('^' + coercedRange)) {
    return semver.satisfies(v, '^' + coercedRange, { includePrerelease: true });
  }
  return false;
}

/** Highest version in the list, or null. */
export function highest(versions: string[]): string | null {
  const valid = versions.map((v) => coerceVersion(v)).filter((v): v is string => v !== null);
  if (valid.length === 0) return null;
  return valid.sort(semver.rcompare)[0] ?? null;
}
