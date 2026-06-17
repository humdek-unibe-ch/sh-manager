// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * JSON Schemas for manager-owned/validated documents.
 *
 * These are intentionally forward-compatible: required fields are enforced but
 * unknown optional fields are tolerated (`additionalProperties` left open) so
 * compatible minor additions do not break older managers. Major-version gating
 * is handled separately by `version.ts`.
 */

type JsonSchema = Record<string, unknown>;

const semverField: JsonSchema = { type: 'string', minLength: 1 };
const sha256Field: JsonSchema = { type: 'string', minLength: 1 };

export const serverInventorySchema: JsonSchema = {
  $id: 'selfhelp/server-inventory.schema.json',
  type: 'object',
  required: ['inventoryVersion', 'serverId', 'manager', 'proxy', 'instances'],
  properties: {
    inventoryVersion: { type: 'integer', minimum: 1 },
    serverId: { type: 'string', minLength: 1 },
    manager: {
      type: 'object',
      required: ['name', 'repository', 'version'],
      properties: {
        name: { type: 'string' },
        repository: { type: 'string' },
        version: semverField,
      },
    },
    proxy: {
      type: 'object',
      required: ['type', 'network', 'composePath'],
      properties: {
        type: { const: 'traefik' },
        network: { type: 'string', minLength: 1 },
        composePath: { type: 'string', minLength: 1 },
      },
    },
    instances: {
      type: 'array',
      items: {
        type: 'object',
        required: ['instanceId', 'domain', 'path', 'composeProject', 'status'],
        properties: {
          instanceId: { type: 'string', minLength: 1 },
          domain: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
          composeProject: { type: 'string', minLength: 1 },
          status: {
            enum: ['active', 'disabled', 'removed_keep_data', 'installing', 'updating', 'error'],
          },
        },
      },
    },
  },
};

export const instanceManifestSchema: JsonSchema = {
  $id: 'selfhelp/instance-manifest.schema.json',
  type: 'object',
  required: [
    'manifestVersion',
    'instanceId',
    'displayName',
    'domain',
    'mode',
    'createdAt',
    'updatedAt',
    'registry',
    'versions',
    'images',
    'routing',
    'installedPlugins',
  ],
  properties: {
    manifestVersion: { type: 'integer', minimum: 1 },
    instanceId: { type: 'string', minLength: 1, pattern: '^[a-z0-9][a-z0-9-]*$' },
    displayName: { type: 'string', minLength: 1 },
    domain: { type: 'string', minLength: 1 },
    mode: { enum: ['production', 'local'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    registry: {
      type: 'object',
      required: ['id', 'url', 'channel'],
      properties: {
        id: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        channel: { enum: ['stable', 'beta', 'nightly', 'test'] },
      },
    },
    versions: {
      type: 'object',
      required: ['selfhelp', 'backend', 'frontend', 'scheduler', 'worker', 'pluginApi'],
      properties: {
        selfhelp: semverField,
        backend: semverField,
        frontend: semverField,
        scheduler: semverField,
        worker: semverField,
        pluginApi: { type: 'string' },
      },
    },
    images: {
      type: 'object',
      required: ['backend', 'frontend', 'scheduler', 'worker', 'mysql', 'redis', 'mercure'],
      properties: {
        backend: { type: 'string' },
        frontend: { type: 'string' },
        scheduler: { type: 'string' },
        worker: { type: 'string' },
        mysql: { type: 'string' },
        redis: { type: 'string' },
        mercure: { type: 'string' },
      },
    },
    routing: {
      type: 'object',
      required: ['publicFrontendUrl', 'browserApiPrefix', 'internalSymfonyUrl', 'symfonyApiPrefix'],
      properties: {
        publicFrontendUrl: { type: 'string' },
        browserApiPrefix: { type: 'string' },
        internalSymfonyUrl: { type: 'string' },
        symfonyApiPrefix: { type: 'string' },
      },
    },
    installedPlugins: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'version'],
        properties: { id: { type: 'string' }, version: semverField },
      },
    },
    // Optional + additive: operator-set non-secret env overrides (string map).
    envOverrides: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    // Optional + additive: instances without a schedule stay valid.
    backupSchedule: {
      type: 'object',
      required: ['enabled', 'time', 'retention'],
      properties: {
        enabled: { type: 'boolean' },
        time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
        retention: {
          type: 'object',
          required: ['daily', 'weekly', 'monthly', 'maxAgeDays'],
          properties: {
            daily: { type: 'integer', minimum: 1, maximum: 90 },
            weekly: { type: 'integer', minimum: 0, maximum: 52 },
            monthly: { type: 'integer', minimum: 0, maximum: 60 },
            maxAgeDays: { type: 'integer', minimum: 7, maximum: 3650 },
          },
        },
      },
    },
  },
};

export const instanceLockSchema: JsonSchema = {
  $id: 'selfhelp/instance-lock.schema.json',
  type: 'object',
  required: ['lockfileVersion', 'generatedAt', 'registry', 'core', 'services', 'plugins'],
  properties: {
    lockfileVersion: { type: 'integer', minimum: 1 },
    generatedAt: { type: 'string', format: 'date-time' },
    operationId: { type: 'string' },
    registry: {
      type: 'object',
      required: ['id', 'url', 'metadataSha256'],
      properties: {
        id: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        metadataSha256: sha256Field,
      },
    },
    core: {
      type: 'object',
      required: [
        'version',
        'backendImageDigest',
        'frontendImageDigest',
        'schedulerImageDigest',
        'workerImageDigest',
        'migrationVersion',
        'pluginApiVersion',
        'signedPayloadSha256',
      ],
      properties: {
        version: semverField,
        backendImageDigest: sha256Field,
        frontendImageDigest: sha256Field,
        schedulerImageDigest: sha256Field,
        workerImageDigest: sha256Field,
        migrationVersion: { type: 'string' },
        pluginApiVersion: { type: 'string' },
        signedPayloadSha256: sha256Field,
        // Optional + additive: the installed core's required frontend range,
        // persisted so frontend-only updates can always enforce it (pre-1.6
        // locks omit it and stay valid).
        requiredFrontendRange: { type: 'string' },
      },
    },
    services: {
      type: 'object',
      required: ['mysql', 'redis', 'mercure'],
      properties: {
        mysql: { $ref: '#/$defs/serviceEntry' },
        redis: { $ref: '#/$defs/serviceEntry' },
        mercure: { $ref: '#/$defs/serviceEntry' },
      },
    },
    plugins: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['version', 'artifactSha256', 'signature', 'keyId', 'compatibility'],
        properties: {
          version: semverField,
          artifactSha256: sha256Field,
          signature: { type: 'string' },
          keyId: { type: 'string' },
          compatibility: {
            type: 'object',
            required: ['core', 'pluginApi'],
            properties: { core: { type: 'string' }, pluginApi: { type: 'string' } },
          },
        },
      },
    },
  },
  $defs: {
    serviceEntry: {
      type: 'object',
      required: ['image', 'digest'],
      properties: { image: { type: 'string' }, digest: sha256Field },
    },
  },
};

const signatureBlockSchema: JsonSchema = {
  type: 'object',
  required: ['signature', 'keyId'],
  properties: {
    signature: { type: 'string', minLength: 1 },
    keyId: { type: 'string', minLength: 1 },
    signedPayload: { type: 'string' },
    signedPayloadSha256: { type: 'string' },
  },
};

export const registryIndexSchema: JsonSchema = {
  $id: 'selfhelp/registry-index.schema.json',
  type: 'object',
  required: ['schemaVersion', 'requiresManager', 'baseUrl', 'publisher', 'core', 'frontend'],
  properties: {
    schemaVersion: { type: 'string', pattern: '^\\d+(\\.\\d+)?$' },
    requiresManager: { type: 'string', minLength: 1 },
    publishedAt: { type: 'string' },
    baseUrl: { type: 'string', format: 'uri' },
    publisher: {
      type: 'object',
      required: ['name', 'url'],
      properties: { name: { type: 'string' }, url: { type: 'string' } },
    },
    core: { type: 'array', items: { $ref: '#/$defs/releaseRef' } },
    frontend: { type: 'array', items: { $ref: '#/$defs/releaseRef' } },
    scheduler: { type: 'array', items: { $ref: '#/$defs/releaseRef' } },
    worker: { type: 'array', items: { $ref: '#/$defs/releaseRef' } },
    // Plugins keep the unified registry's richer per-entry shape (they carry
    // manifestUrl + their own signature block), so they are validated loosely
    // here: only the fields the resolver needs are required.
    plugins: { type: 'array', items: { $ref: '#/$defs/pluginRef' } },
  },
  $defs: {
    releaseRef: {
      type: 'object',
      required: ['id', 'version', 'channel', 'releaseUrl'],
      properties: {
        id: { type: 'string' },
        version: semverField,
        channel: { enum: ['stable', 'beta', 'nightly', 'test'] },
        releaseUrl: { type: 'string' },
        blocked: { type: 'boolean' },
      },
    },
    pluginRef: {
      type: 'object',
      required: ['id', 'version', 'channel'],
      properties: {
        id: { type: 'string' },
        version: semverField,
        channel: { type: 'string' },
        blocked: { type: 'boolean' },
      },
    },
  },
};

export const coreReleaseSchema: JsonSchema = {
  $id: 'selfhelp/core-release.schema.json',
  type: 'object',
  required: [
    'kind',
    'id',
    'version',
    'channel',
    'minimumDirectUpgradeFrom',
    'pluginApiVersion',
    'backend',
    'worker',
    'scheduler',
    'frontendCompatibility',
    'database',
    'security',
  ],
  properties: {
    kind: { const: 'selfhelp-core-release' },
    id: { type: 'string' },
    version: semverField,
    channel: { enum: ['stable', 'beta', 'nightly', 'test'] },
    releasedAt: { type: 'string' },
    minimumDirectUpgradeFrom: semverField,
    pluginApiVersion: { type: 'string' },
    backend: { $ref: '#/$defs/imageRef' },
    worker: { $ref: '#/$defs/imageRef' },
    scheduler: { $ref: '#/$defs/imageRef' },
    frontendCompatibility: {
      type: 'object',
      required: ['requiredFrontendRange'],
      properties: { requiredFrontendRange: { type: 'string' } },
    },
    database: {
      type: 'object',
      required: ['migrationRange', 'destructive', 'requiresBackup', 'manualConfirmationRequired'],
      properties: {
        migrationRange: { type: 'string' },
        destructive: { type: 'boolean' },
        requiresBackup: { type: 'boolean' },
        manualConfirmationRequired: { type: 'boolean' },
        minimumSafeRollbackPoint: { type: 'string' },
        automaticRollback: { type: 'string' },
      },
    },
    security: signatureBlockSchema,
    blocked: { type: 'boolean' },
  },
  $defs: {
    imageRef: {
      type: 'object',
      required: ['image', 'digest'],
      properties: {
        image: { type: 'string' },
        digest: sha256Field,
        phpVersion: { type: 'string' },
      },
    },
  },
};

export const frontendReleaseSchema: JsonSchema = {
  $id: 'selfhelp/frontend-release.schema.json',
  type: 'object',
  required: ['kind', 'id', 'version', 'channel', 'image', 'digest', 'backendCompatibility', 'security'],
  properties: {
    kind: { const: 'selfhelp-frontend-release' },
    id: { type: 'string' },
    version: semverField,
    channel: { enum: ['stable', 'beta', 'nightly', 'test'] },
    image: { type: 'string' },
    digest: sha256Field,
    builtFrom: { type: 'object' },
    backendCompatibility: {
      type: 'object',
      required: ['requiredCoreRange', 'requiredApiVersion'],
      properties: {
        requiredCoreRange: { type: 'string' },
        requiredApiVersion: { type: 'string' },
      },
    },
    security: signatureBlockSchema,
    blocked: { type: 'boolean' },
  },
};

const serviceReleaseSchema = (kind: string): JsonSchema => ({
  $id: `selfhelp/${kind}.schema.json`,
  type: 'object',
  required: ['kind', 'id', 'version', 'channel', 'image', 'digest', 'backendCompatibility', 'security'],
  properties: {
    kind: { const: kind },
    id: { type: 'string' },
    version: semverField,
    channel: { enum: ['stable', 'beta', 'nightly', 'test'] },
    image: { type: 'string' },
    digest: sha256Field,
    builtFrom: { type: 'object' },
    backendCompatibility: {
      type: 'object',
      required: ['requiredCoreRange'],
      properties: {
        requiredCoreRange: { type: 'string' },
        requiredApiVersion: { type: 'string' },
      },
    },
    security: signatureBlockSchema,
    blocked: { type: 'boolean' },
  },
});

export const schedulerReleaseSchema: JsonSchema = serviceReleaseSchema('selfhelp-scheduler-release');
export const workerReleaseSchema: JsonSchema = serviceReleaseSchema('selfhelp-worker-release');

export const advisoryFeedSchema: JsonSchema = {
  $id: 'selfhelp/advisory-feed.schema.json',
  type: 'object',
  required: ['schemaVersion', 'advisories'],
  properties: {
    schemaVersion: { type: 'string' },
    advisories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'severity', 'affected', 'fixed', 'recommendedAction', 'blocked'],
        properties: {
          id: { type: 'string' },
          severity: { enum: ['low', 'medium', 'high', 'critical'] },
          affected: { type: 'array' },
          fixed: { type: 'array' },
          recommendedAction: { type: 'string' },
          blocked: { type: 'boolean' },
          detailsUrl: { type: 'string' },
        },
      },
    },
  },
};

export const updatePreflightSchema: JsonSchema = {
  $id: 'selfhelp/update-preflight.schema.json',
  type: 'object',
  required: [
    'preflightVersion',
    'status',
    'instanceId',
    'currentVersion',
    'targetVersion',
    'checks',
    'options',
    'database',
    'rollback',
  ],
  properties: {
    preflightVersion: { type: 'integer', minimum: 1 },
    status: { enum: ['ok', 'warning', 'blocked'] },
    instanceId: { type: 'string' },
    currentVersion: { type: 'string' },
    targetVersion: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'severity', 'message'],
        properties: {
          code: { type: 'string' },
          severity: { enum: ['info', 'warning', 'error'] },
          message: { type: 'string' },
        },
      },
    },
    options: { type: 'array' },
    database: {
      type: 'object',
      required: ['destructive', 'requiresBackup', 'manualConfirmationRequired'],
      properties: {
        destructive: { type: 'boolean' },
        requiresBackup: { type: 'boolean' },
        manualConfirmationRequired: { type: 'boolean' },
      },
    },
    rollback: {
      type: 'object',
      required: ['automaticBeforeMigrations', 'automaticAfterDestructiveMigrations'],
      properties: {
        automaticBeforeMigrations: { type: 'boolean' },
        automaticAfterDestructiveMigrations: { type: 'boolean' },
      },
    },
  },
};

export const backupManifestSchema: JsonSchema = {
  $id: 'selfhelp/backup-manifest.schema.json',
  type: 'object',
  required: [
    'backupManifestVersion',
    'backupId',
    'instanceId',
    'createdAt',
    'mode',
    'selfhelpVersion',
    'migrationVersion',
    'plugins',
    'includedAreas',
    'files',
  ],
  properties: {
    backupManifestVersion: { type: 'integer', minimum: 1 },
    backupId: { type: 'string', minLength: 1 },
    instanceId: { type: 'string', minLength: 1 },
    createdAt: { type: 'string' },
    mode: { enum: ['maintenance', 'online'] },
    // Optional + additive: legacy manifests without an origin remain valid.
    origin: { enum: ['manual', 'scheduled', 'pre_update', 'pre_restore'] },
    selfhelpVersion: semverField,
    migrationVersion: { type: 'string', minLength: 1 },
    plugins: { type: 'array' },
    includedAreas: { type: 'array', items: { type: 'string' } },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'sha256', 'bytes'],
        properties: {
          path: { type: 'string' },
          sha256: sha256Field,
          bytes: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
};

export const trustedKeysSchema: JsonSchema = {
  $id: 'selfhelp/trusted-keys.schema.json',
  type: 'object',
  required: ['schemaVersion', 'keys'],
  properties: {
    schemaVersion: { type: 'string' },
    keys: {
      type: 'array',
      items: {
        type: 'object',
        required: ['keyId', 'publicKey', 'algorithm', 'status'],
        properties: {
          keyId: { type: 'string', minLength: 1 },
          publicKey: { type: 'string', minLength: 1 },
          algorithm: { const: 'ed25519' },
          status: { enum: ['active', 'revoked'] },
        },
      },
    },
  },
};

export const ALL_SCHEMAS: Record<string, JsonSchema> = {
  serverInventory: serverInventorySchema,
  instanceManifest: instanceManifestSchema,
  instanceLock: instanceLockSchema,
  registryIndex: registryIndexSchema,
  coreRelease: coreReleaseSchema,
  frontendRelease: frontendReleaseSchema,
  schedulerRelease: schedulerReleaseSchema,
  workerRelease: workerReleaseSchema,
  advisoryFeed: advisoryFeedSchema,
  updatePreflight: updatePreflightSchema,
  backupManifest: backupManifestSchema,
  trustedKeys: trustedKeysSchema,
};
