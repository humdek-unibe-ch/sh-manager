// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { ALL_SCHEMAS } from './json-schemas.js';
import type {
  BackupManifest,
  CoreRelease,
  FrontendRelease,
  InstanceLock,
  InstanceManifest,
  MobilePreviewRelease,
  PluginRelease,
  RegistryIndex,
  SchedulerRelease,
  ServerInventory,
  TrustedKeysFile,
  UpdatePreflightResult,
  WorkerRelease,
} from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const compiled = new Map<string, ValidateFunction>();
for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
  compiled.set(name, ajv.compile(schema));
}

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: string[];
}

function run<T>(schemaName: string, data: unknown): ValidationResult<T> {
  const validate = compiled.get(schemaName);
  if (!validate) {
    return { valid: false, errors: [`Unknown schema "${schemaName}".`] };
  }
  const valid = validate(data);
  if (valid) {
    return { valid: true, value: data as T, errors: [] };
  }
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`.trim(),
  );
  return { valid: false, errors };
}

export const validateServerInventory = (d: unknown): ValidationResult<ServerInventory> =>
  run('serverInventory', d);
export const validateInstanceManifest = (d: unknown): ValidationResult<InstanceManifest> =>
  run('instanceManifest', d);
export const validateInstanceLock = (d: unknown): ValidationResult<InstanceLock> =>
  run('instanceLock', d);
export const validateRegistryIndex = (d: unknown): ValidationResult<RegistryIndex> =>
  run('registryIndex', d);
export const validateCoreRelease = (d: unknown): ValidationResult<CoreRelease> =>
  run('coreRelease', d);
export const validateFrontendRelease = (d: unknown): ValidationResult<FrontendRelease> =>
  run('frontendRelease', d);
export const validateSchedulerRelease = (d: unknown): ValidationResult<SchedulerRelease> =>
  run('schedulerRelease', d);
export const validateWorkerRelease = (d: unknown): ValidationResult<WorkerRelease> =>
  run('workerRelease', d);
export const validateMobilePreviewRelease = (d: unknown): ValidationResult<MobilePreviewRelease> =>
  run('mobilePreviewRelease', d);
export const validatePluginRelease = (d: unknown): ValidationResult<PluginRelease> =>
  run('pluginRelease', d);
export const validateUpdatePreflight = (d: unknown): ValidationResult<UpdatePreflightResult> =>
  run('updatePreflight', d);
export const validateBackupManifest = (d: unknown): ValidationResult<BackupManifest> =>
  run('backupManifest', d);
export const validateTrustedKeys = (d: unknown): ValidationResult<TrustedKeysFile> =>
  run('trustedKeys', d);

export const SCHEMA_NAMES = Object.keys(ALL_SCHEMAS);

/** Generic validation by schema name (used by the schema-validation script). */
export function validateBySchemaName(schemaName: string, data: unknown): ValidationResult<unknown> {
  return run(schemaName, data);
}
