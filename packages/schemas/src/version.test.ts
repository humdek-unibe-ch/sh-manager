// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertSchemaCompatible,
  checkSchemaCompatibility,
  MANAGER_VERSION,
  parseSchemaVersion,
  releaseVersionMismatch,
  requiresManagerSatisfied,
  SchemaCompatibilityError,
} from './version.js';

describe('MANAGER_VERSION', () => {
  it('matches the root package.json version (a release bump must change both)', () => {
    // Regression: v1.0.11/v1.0.12 were tagged with only package.json bumped,
    // so the published images reported 1.0.10 and self-update saw a
    // permanently available update. This pins the two sources together —
    // the release gate (npm run check) fails when they drift.
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(MANAGER_VERSION).toBe(pkg.version);
  });
});

describe('releaseVersionMismatch', () => {
  it('passes when the tag, package.json, and MANAGER_VERSION all agree', () => {
    expect(releaseVersionMismatch('v1.6.2', '1.6.2', '1.6.2')).toBeNull();
  });

  it('tolerates a tag with or without the leading v', () => {
    expect(releaseVersionMismatch('1.6.2', '1.6.2', '1.6.2')).toBeNull();
  });

  it('fails when the tag is ahead of the code (the v1.6.2-reported-1.6.1 bug)', () => {
    // The exact regression: tag v1.6.2 pushed while the code is still 1.6.1.
    const reason = releaseVersionMismatch('v1.6.2', '1.6.1', '1.6.1');
    expect(reason).toMatch(/tag "v1\.6\.2" does not match package\.json version "1\.6\.1"/);
  });

  it('fails when MANAGER_VERSION drifts from package.json even if the tag matches', () => {
    const reason = releaseVersionMismatch('v1.6.2', '1.6.2', '1.6.1');
    expect(reason).toMatch(/MANAGER_VERSION "1\.6\.1" does not match package\.json version "1\.6\.2"/);
  });

  it('fails when no tag is supplied', () => {
    expect(releaseVersionMismatch('', '1.6.2', '1.6.2')).toMatch(/No release tag/);
  });
});

describe('parseSchemaVersion', () => {
  it('parses major.minor strings', () => {
    expect(parseSchemaVersion('1.2')).toEqual({ major: 1, minor: 2 });
    expect(parseSchemaVersion('2')).toEqual({ major: 2, minor: 0 });
  });
  it('accepts integer versions', () => {
    expect(parseSchemaVersion(1)).toEqual({ major: 1, minor: 0 });
  });
  it('rejects malformed values', () => {
    expect(parseSchemaVersion('x')).toBeNull();
    expect(parseSchemaVersion(undefined)).toBeNull();
    expect(parseSchemaVersion(null)).toBeNull();
  });
});

describe('checkSchemaCompatibility', () => {
  it('tolerates compatible minor additions within the supported major', () => {
    const r = checkSchemaCompatibility('registry', '1.5');
    expect(r.compatible).toBe(true);
    expect(r.unverifiable).toBe(false);
  });

  it('rejects unknown (newer) major versions', () => {
    const r = checkSchemaCompatibility('registry', '2.0');
    expect(r.compatible).toBe(false);
    expect(r.reason).toMatch(/Update SelfHelp Manager first/);
  });

  it('treats missing/malformed versions as unverifiable and unsafe', () => {
    const r = checkSchemaCompatibility('manifest', undefined);
    expect(r.compatible).toBe(false);
    expect(r.unverifiable).toBe(true);
  });

  it('assertSchemaCompatible throws on unsafe versions', () => {
    expect(() => assertSchemaCompatible('lock', '9.9')).toThrow(SchemaCompatibilityError);
    expect(() => assertSchemaCompatible('lock', 1)).not.toThrow();
  });
});

describe('requiresManagerSatisfied', () => {
  it('passes when the running manager satisfies the range', () => {
    expect(requiresManagerSatisfied('>=0.1.0 <1.0.0', '0.1.0').satisfied).toBe(true);
  });
  it('fails and instructs to update when the manager is too old', () => {
    const r = requiresManagerSatisfied('>=1.1.0 <2.0.0', '0.1.0');
    expect(r.satisfied).toBe(false);
    expect(r.reason).toMatch(/Update SelfHelp Manager first/);
  });
  it('treats invalid ranges as unsafe', () => {
    expect(requiresManagerSatisfied('not-a-range', '0.1.0').satisfied).toBe(false);
  });
});
