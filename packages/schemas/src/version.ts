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
 *
 * This MUST equal the root `package.json` version (a test pins them together)
 * AND the published git tag (`v<version>`). The release workflow runs
 * {@link releaseVersionMismatch} so a tag pushed without bumping the code can
 * never publish an image that self-reports a stale version (the v1.6.2 image
 * that still reported 1.6.1 after a tag-only release).
 */
export const MANAGER_VERSION = '1.6.8';

/**
 * Release-time guard: verify the published git tag, the root `package.json`
 * version, and the compiled-in {@link MANAGER_VERSION} all agree BEFORE the
 * image is built and pushed.
 *
 * Why this exists: a release that bumps only the tag (or only the changelog)
 * ships an image whose self-reported version — `sh-manager --version`, the web
 * console header, inventory stamps, and the "current version" `self-update`
 * compares against — disagrees with its tag. That is exactly how the `v1.6.2`
 * image kept reporting `1.6.1` after operators updated to it. `npm run check`
 * (run at release) already pins `MANAGER_VERSION` to `package.json`; this adds
 * the missing third leg (the tag) so the three can never drift.
 *
 * A leading `v` on the tag is optional. Returns `null` when everything matches;
 * otherwise a human-readable reason the release should fail with.
 */
export function releaseVersionMismatch(
  tag: string,
  packageVersion: string,
  managerVersion: string = MANAGER_VERSION,
): string | null {
  const tagVersion = tag.trim().replace(/^v/, '');
  if (!tagVersion) {
    return 'No release tag provided to verify against the package version.';
  }
  if (tagVersion !== packageVersion) {
    return (
      `Release tag "${tag}" does not match package.json version "${packageVersion}". ` +
      `Bump package.json and MANAGER_VERSION to ${tagVersion} before tagging (or tag v${packageVersion}).`
    );
  }
  if (managerVersion !== packageVersion) {
    return (
      `MANAGER_VERSION "${managerVersion}" does not match package.json version "${packageVersion}". ` +
      'Update packages/schemas/src/version.ts so the image reports the released version.'
    );
  }
  return null;
}

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
