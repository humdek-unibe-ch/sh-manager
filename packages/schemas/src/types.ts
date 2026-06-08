// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Canonical TypeScript contracts for the SelfHelp distribution system.
 *
 * These mirror the shapes documented in
 * `sh-selfhelp_backend/docs/archive/core-installation-and-distribution-plan.md`
 * and are the source of truth consumed by the manager packages. Where the
 * frontend/mobile also consume a shape, the matching type lives in
 * `@selfhelp/shared` and must stay in parity.
 */

export type ReleaseChannel = 'stable' | 'beta' | 'nightly';
export type InstanceMode = 'production' | 'local';
export type TrustLevel = 'official' | 'reviewed' | 'untrusted';
export type AdvisorySeverity = 'low' | 'medium' | 'high' | 'critical';

/** Ed25519 detached-signature block shared by every signed registry payload. */
export interface SignatureBlock {
  signature: string;
  keyId: string;
  signedPayload?: string;
  signedPayloadSha256?: string;
}

// ---------------------------------------------------------------------------
// Server inventory (/opt/selfhelp/selfhelp.server.json)
// ---------------------------------------------------------------------------

export type InstanceStatus =
  | 'active'
  | 'disabled'
  | 'removed_keep_data'
  | 'installing'
  | 'updating'
  | 'error';

export interface InventoryInstanceEntry {
  instanceId: string;
  domain: string;
  path: string;
  composeProject: string;
  status: InstanceStatus;
}

export interface ServerInventory {
  inventoryVersion: number;
  serverId: string;
  manager: {
    name: string;
    repository: string;
    version: string;
  };
  proxy: {
    type: 'traefik';
    network: string;
    composePath: string;
  };
  instances: InventoryInstanceEntry[];
}

// ---------------------------------------------------------------------------
// Instance manifest (selfhelp.instance.json)
// ---------------------------------------------------------------------------

export interface InstanceVersions {
  selfhelp: string;
  backend: string;
  frontend: string;
  scheduler: string;
  worker: string;
  pluginApi: string;
}

export interface InstanceImages {
  backend: string;
  frontend: string;
  scheduler: string;
  worker: string;
  mysql: string;
  redis: string;
  mercure: string;
}

export interface InstanceRouting {
  publicFrontendUrl: string;
  browserApiPrefix: string;
  internalSymfonyUrl: string;
  symfonyApiPrefix: string;
}

export interface InstalledPlugin {
  id: string;
  version: string;
}

export interface InstanceManifest {
  manifestVersion: number;
  instanceId: string;
  displayName: string;
  domain: string;
  mode: InstanceMode;
  createdAt: string;
  updatedAt: string;
  registry: {
    id: string;
    url: string;
    channel: ReleaseChannel;
  };
  versions: InstanceVersions;
  images: InstanceImages;
  routing: InstanceRouting;
  installedPlugins: InstalledPlugin[];
  /** Operator-facing resource configuration (best-effort estimate inputs). */
  resources?: InstanceResourceConfig;
}

export interface InstanceResourceConfig {
  memoryLimitMb?: number;
  cpuLimit?: number;
  diskWarnThresholdGb?: number;
  logMaxSizeMb?: number;
  logMaxFiles?: number;
}

// ---------------------------------------------------------------------------
// Instance lock file (selfhelp.lock.json)
// ---------------------------------------------------------------------------

export interface LockServiceEntry {
  image: string;
  digest: string;
}

export interface LockPluginEntry {
  version: string;
  artifactSha256: string;
  signature: string;
  keyId: string;
  compatibility: {
    core: string;
    pluginApi: string;
  };
}

export interface InstanceLock {
  lockfileVersion: number;
  generatedAt: string;
  operationId?: string;
  registry: {
    id: string;
    url: string;
    metadataSha256: string;
  };
  core: {
    version: string;
    backendImageDigest: string;
    frontendImageDigest: string;
    schedulerImageDigest: string;
    workerImageDigest: string;
    migrationVersion: string;
    pluginApiVersion: string;
    signedPayloadSha256: string;
  };
  services: {
    mysql: LockServiceEntry;
    redis: LockServiceEntry;
    mercure: LockServiceEntry;
  };
  plugins: Record<string, LockPluginEntry>;
}

// ---------------------------------------------------------------------------
// Registry index + release metadata
// ---------------------------------------------------------------------------

export interface RegistryReleaseRef {
  id: string;
  version: string;
  channel: ReleaseChannel;
  releaseUrl: string;
  blocked?: boolean;
}

export interface RegistryIndex {
  schemaVersion: string;
  requiresManager: string;
  publishedAt: string;
  baseUrl: string;
  publisher: {
    name: string;
    url: string;
  };
  core: RegistryReleaseRef[];
  frontend: RegistryReleaseRef[];
  scheduler: RegistryReleaseRef[];
  worker: RegistryReleaseRef[];
  plugins: RegistryReleaseRef[];
  advisoriesUrl?: string;
  compatibilityUrl?: string;
  trustedKeysUrl?: string;
}

export interface DatabaseMigrationMetadata {
  migrationRange: string;
  destructive: boolean;
  requiresBackup: boolean;
  manualConfirmationRequired: boolean;
  minimumSafeRollbackPoint?: string;
  automaticRollback?: string;
}

export interface ImageRef {
  image: string;
  digest: string;
  phpVersion?: string;
}

export interface CoreRelease {
  kind: 'selfhelp-core-release';
  id: string;
  version: string;
  channel: ReleaseChannel;
  releasedAt: string;
  minimumDirectUpgradeFrom: string;
  pluginApiVersion: string;
  backend: ImageRef;
  worker: ImageRef;
  scheduler: ImageRef;
  frontendCompatibility: { requiredFrontendRange: string };
  database: DatabaseMigrationMetadata;
  runtime?: RuntimeServicePolicy;
  artifacts?: { sbom?: { url: string; sha256: string } };
  security: SignatureBlock;
  blocked?: boolean;
}

export interface FrontendRelease {
  kind: 'selfhelp-frontend-release';
  id: string;
  version: string;
  channel: ReleaseChannel;
  image: string;
  digest: string;
  builtFrom?: { nextStandalone: boolean; sharedPackageVersion: string };
  backendCompatibility: { requiredCoreRange: string; requiredApiVersion: string };
  security: SignatureBlock;
  blocked?: boolean;
}

/** Compatibility descriptor shared by core-coupled service releases. */
export interface ServiceBackendCompatibility {
  requiredCoreRange: string;
  /** Optional CMS API contract version; core-coupled services may omit it. */
  requiredApiVersion?: string;
}

/**
 * Scheduled-jobs runner release. Built from the same core source as the
 * backend but resolved/pinned as a first-class artifact so an instance can run
 * a distinct scheduler version.
 */
export interface SchedulerRelease {
  kind: 'selfhelp-scheduler-release';
  id: string;
  version: string;
  channel: ReleaseChannel;
  image: string;
  digest: string;
  builtFrom?: Record<string, unknown>;
  backendCompatibility: ServiceBackendCompatibility;
  security: SignatureBlock;
  blocked?: boolean;
}

/**
 * Messenger worker release. Built from the same core source as the backend but
 * resolved/pinned as a first-class artifact so an instance can run a distinct
 * worker version.
 */
export interface WorkerRelease {
  kind: 'selfhelp-worker-release';
  id: string;
  version: string;
  channel: ReleaseChannel;
  image: string;
  digest: string;
  builtFrom?: Record<string, unknown>;
  backendCompatibility: ServiceBackendCompatibility;
  security: SignatureBlock;
  blocked?: boolean;
}

export interface PluginRelease {
  kind: 'selfhelp-plugin-release';
  id: string;
  version: string;
  channel: ReleaseChannel;
  official: boolean;
  compatibility: { core: string; pluginApi: string };
  dependencies?: { plugins: { id: string; range: string }[] };
  artifacts: { manifestUrl: string; archiveUrl: string; sha256: string };
  security: SignatureBlock;
  blocked?: boolean;
}

export interface RuntimeServiceRange {
  supportedVersions: string;
  minimumRequired?: string;
  recommendedVersion?: string;
  recommendedImage: string;
  recommendedDigest?: string;
  updateRequired?: boolean;
  majorUpgradeRequiresManualApproval?: boolean;
}

export interface RuntimeServicePolicy {
  php?: { backendImagePhpVersion: string };
  mysql: RuntimeServiceRange;
  redis: RuntimeServiceRange;
  mercure: RuntimeServiceRange;
  traefik?: RuntimeServiceRange;
}

// ---------------------------------------------------------------------------
// Compatibility + advisories
// ---------------------------------------------------------------------------

export interface CompatibilityRules {
  schemaVersion: string;
  rules: {
    selfhelp: string;
    runtime: RuntimeServicePolicy;
  }[];
}

export interface AdvisoryAffected {
  kind: 'core' | 'frontend' | 'plugin';
  id?: string;
  versions: string;
}

export interface SecurityAdvisory {
  id: string;
  severity: AdvisorySeverity;
  affected: AdvisoryAffected[];
  fixed: { kind: 'core' | 'frontend' | 'plugin'; id?: string; version: string }[];
  recommendedAction: string;
  blocked: boolean;
  detailsUrl?: string;
}

export interface AdvisoryFeed {
  schemaVersion: string;
  advisories: SecurityAdvisory[];
}

export interface TrustedKey {
  keyId: string;
  publicKey: string;
  algorithm: 'ed25519';
  status: 'active' | 'revoked';
}

export interface TrustedKeysFile {
  schemaVersion: string;
  keys: TrustedKey[];
}

// ---------------------------------------------------------------------------
// Preflight / update plan
// ---------------------------------------------------------------------------

export type PreflightStatus = 'ok' | 'warning' | 'blocked';
export type CheckSeverity = 'info' | 'warning' | 'error';

export interface PreflightCheck {
  code: string;
  severity: CheckSeverity;
  message: string;
}

export interface PreflightOption {
  type: string;
  version?: string;
  label: string;
}

export interface UpdatePreflightResult {
  preflightVersion: number;
  status: PreflightStatus;
  instanceId: string;
  currentVersion: string;
  targetVersion: string;
  checks: PreflightCheck[];
  options: PreflightOption[];
  database: {
    destructive: boolean;
    requiresBackup: boolean;
    manualConfirmationRequired: boolean;
  };
  rollback: {
    automaticBeforeMigrations: boolean;
    automaticAfterDestructiveMigrations: boolean;
  };
}

// ---------------------------------------------------------------------------
// Backup manifest
// ---------------------------------------------------------------------------

export interface BackupManifest {
  backupManifestVersion: number;
  backupId: string;
  instanceId: string;
  createdAt: string;
  mode: 'maintenance' | 'online';
  selfhelpVersion: string;
  migrationVersion: string;
  plugins: InstalledPlugin[];
  includedAreas: string[];
  files: { path: string; sha256: string; bytes: number }[];
}

// ---------------------------------------------------------------------------
// Support bundle
// ---------------------------------------------------------------------------

export interface SupportBundleMeta {
  supportBundleVersion: number;
  instanceId: string;
  createdAt: string;
  managerVersion: string;
  schemaVersions: Record<string, number | string>;
  redactionApplied: true;
  contents: string[];
}

// ---------------------------------------------------------------------------
// CMS-facing system/version + update contracts
// ---------------------------------------------------------------------------

export interface SystemVersionResponse {
  instanceId: string;
  selfhelpVersion: string;
  backendVersion: string;
  frontendVersion: string;
  pluginApiVersion: string;
  databaseMigrationVersion: string;
  safeMode: boolean;
  maintenanceMode: boolean;
  installedPlugins: { id: string; version: string; compatible: boolean }[];
}

/**
 * Update approval request. `instanceId` is the *server-derived* instance
 * identity. The browser must never provide an arbitrary `instanceId`; the
 * backend/manager derives and verifies it from trusted configuration.
 */
export interface UpdateApprovalRequest {
  instanceId: string;
  targetVersion: string;
  preflightId: string;
  approvedByUserId: number;
  approvalToken: string;
  acceptedMigrationRisk: boolean;
}
