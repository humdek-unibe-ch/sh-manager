// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  assertSchemaCompatible,
  checkSchemaCompatibility,
  parseSchemaVersion,
  requiresManagerSatisfied,
  SchemaCompatibilityError,
} from './version.js';

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
