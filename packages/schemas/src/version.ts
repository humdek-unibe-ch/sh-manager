// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Schema-version compatibility gating.
 *
 * The manager must:
 * - reject unknown *major* schema versions;
 * - tolerate compatible *minor* additions;
 * - refuse unsafe operations when compatibility cannot be verified;
 * - surface a clear "update SelfHelp Manager first" error when the registry
 *   requires a newer manager than the running one.
 */
import semver from 'semver';

/**
 * Running manager version — the single source of truth.
 * Update here + root package.json + CHANGELOG.md when releasing (the CLI,
 * web UI, and inventory stamps all import this constant).
 */
export const MANAGER_VERSION = '1.0.8';

/** Document kinds that carry a `*Version`/`schemaVersion` field. */
export type SchemaDocKind =
  | 'registry'
  | 'inventory'
  | 'manifest'
  | 'lock'
  | 'preflight'
  | 'advisory'
  | 'compatibility'
  | 'backupManifest'
  | 'supportBundle';

/**
 * The highest *major* version of each document kind this manager understands.
 * Minor additions within the same major are forward-compatible.
 */
export const SUPPORTED_SCHEMA_MAJOR: Record<SchemaDocKind, number> = {
  registry: 1,
  inventory: 1,
  manifest: 1,
  lock: 1,
  preflight: 1,
  advisory: 1,
  compatibility: 1,
  backupManifest: 1,
  supportBundle: 1,
};

export interface ParsedSchemaVersion {
  major: number;
  minor: number;
}

/**
 * Parses a `major.minor` (or bare integer) schema version. Returns `null`
 * when the value is missing or malformed so callers can treat it as unsafe.
 */
export function parseSchemaVersion(value: unknown): ParsedSchemaVersion | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return { major: value, minor: 0 };
  }
  if (typeof value !== 'string') return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

export interface SchemaCompatibility {
  compatible: boolean;
  /** True only when the version is malformed/missing (treat as unsafe). */
  unverifiable: boolean;
  detected: ParsedSchemaVersion | null;
  supportedMajor: number;
  reason?: string;
}

/**
 * Checks one document version against the supported major for its kind.
 * Unknown major versions and unparseable values are rejected.
 */
export function checkSchemaCompatibility(
  kind: SchemaDocKind,
  version: unknown,
): SchemaCompatibility {
  const supportedMajor = SUPPORTED_SCHEMA_MAJOR[kind];
  const detected = parseSchemaVersion(version);
  if (detected === null) {
    return {
      compatible: false,
      unverifiable: true,
      detected: null,
      supportedMajor,
      reason: `Missing or malformed ${kind} schema version; treating operation as unsafe.`,
    };
  }
  if (detected.major > supportedMajor) {
    return {
      compatible: false,
      unverifiable: false,
      detected,
      supportedMajor,
      reason:
        `${kind} schema major ${detected.major} is newer than supported major ` +
        `${supportedMajor}. Update SelfHelp Manager first.`,
    };
  }
  if (detected.major < supportedMajor) {
    // Older majors are read-tolerated for display; callers gate writes.
    return { compatible: true, unverifiable: false, detected, supportedMajor };
  }
  return { compatible: true, unverifiable: false, detected, supportedMajor };
}

export class SchemaCompatibilityError extends Error {
  constructor(
    message: string,
    readonly kind: SchemaDocKind,
    readonly detail: SchemaCompatibility,
  ) {
    super(message);
    this.name = 'SchemaCompatibilityError';
  }
}

/** Throws {@link SchemaCompatibilityError} when the version is unsafe. */
export function assertSchemaCompatible(kind: SchemaDocKind, version: unknown): void {
  const result = checkSchemaCompatibility(kind, version);
  if (!result.compatible) {
    throw new SchemaCompatibilityError(result.reason ?? 'Incompatible schema version.', kind, result);
  }
}

/**
 * Verifies the running manager satisfies the registry's `requiresManager`
 * semver range. Returns a structured result so the CLI/UI can instruct the
 * operator to update the manager.
 */
export function requiresManagerSatisfied(
  requiresManager: string,
  managerVersion: string = MANAGER_VERSION,
): { satisfied: boolean; reason?: string } {
  if (!semver.validRange(requiresManager)) {
    return {
      satisfied: false,
      reason: `Registry "requiresManager" range "${requiresManager}" is invalid; treating as unsafe.`,
    };
  }
  const coerced = semver.coerce(managerVersion)?.version ?? managerVersion;
  if (!semver.valid(coerced)) {
    return { satisfied: false, reason: `Manager version "${managerVersion}" is invalid.` };
  }
  if (!semver.satisfies(coerced, requiresManager, { includePrerelease: true })) {
    return {
      satisfied: false,
      reason: `Registry requires manager ${requiresManager}; running ${managerVersion}. Update SelfHelp Manager first.`,
    };
  }
  return { satisfied: true };
}
