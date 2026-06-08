// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Restore safety + planning.
 *
 * A backup that cannot be read, identified and matched to an instance is not a
 * valid safety point. Restore/clone must refuse mismatched backups unless a
 * documented disaster-recovery import path is used.
 */
import type { BackupManifest } from '@shm/schemas';
import { verifyBackupIntegrity, type IntegrityResult } from './manifest.js';

export type RestoreMode = 'same_instance' | 'restore_as_clone';

export interface RestoreRequest {
  targetInstanceId: string;
  backupId: string;
  mode: RestoreMode;
  preserveSecrets?: boolean;
  generateNewSecrets?: boolean;
  newDomain?: string;
  runHealthChecks?: boolean;
  typedConfirmation?: string;
  /** Disaster-recovery: allow importing a backup whose instance id differs. */
  disasterRecoveryImport?: boolean;
}

export interface BackupValidation {
  ok: boolean;
  errors: string[];
}

export function validateBackupForRestore(
  req: RestoreRequest,
  manifest: BackupManifest,
  requiredAreas: string[],
  actualHashes?: Record<string, string>,
): BackupValidation {
  const errors: string[] = [];

  if (!manifest.backupId) errors.push('Backup id is missing.');
  if (manifest.backupId !== req.backupId) {
    errors.push(`Backup id mismatch (requested ${req.backupId}, manifest ${manifest.backupId}).`);
  }
  if (!manifest.selfhelpVersion) errors.push('Backup SelfHelp version is missing.');
  if (!manifest.migrationVersion) errors.push('Backup migration version is missing.');
  if (manifest.plugins === undefined) errors.push('Backup plugin metadata is missing.');

  if (req.mode === 'same_instance' && manifest.instanceId !== req.targetInstanceId && !req.disasterRecoveryImport) {
    errors.push(
      `Backup belongs to instance "${manifest.instanceId}", not "${req.targetInstanceId}". ` +
        'Use the documented disaster-recovery import to override.',
    );
  }

  for (const area of requiredAreas) {
    if (!manifest.includedAreas.includes(area)) {
      errors.push(`Backup does not include required data area "${area}".`);
    }
  }

  if (actualHashes) {
    const integrity: IntegrityResult = verifyBackupIntegrity(manifest, actualHashes);
    if (!integrity.ok) errors.push(...integrity.errors);
  }

  return { ok: errors.length === 0, errors };
}

export interface RestorePlan {
  targetInstanceId: string;
  backupId: string;
  mode: RestoreMode;
  preserveSecrets: boolean;
  generateNewSecrets: boolean;
  steps: string[];
  /** Volumes that must be preserved (never deleted) during restore. */
  preservedDuringStop: string[];
  forbiddenCommands: string[];
}

export function planRestore(req: RestoreRequest, manifest: BackupManifest): RestorePlan {
  const sameInstance = req.mode === 'same_instance';
  const preserveSecrets = sameInstance ? req.preserveSecrets ?? true : false;
  const generateNewSecrets = sameInstance ? false : req.generateNewSecrets ?? true;

  const steps: string[] = [
    'verify backup integrity and metadata',
    'verify required artifacts available + signed/checksummed',
  ];
  if (sameInstance) {
    steps.push('stop target instance containers (keep volumes)');
    steps.push(`restore database (version ${manifest.selfhelpVersion}), uploads, plugin artifacts, manifest, lock`);
    if (preserveSecrets) steps.push('preserve existing secrets');
  } else {
    steps.push('create new isolated instance id/domain/networks/volumes');
    steps.push('generate new APP_SECRET, JWT keys, Mercure secrets, DB/Redis passwords');
    steps.push('restore database + uploads + plugin artifacts into the clone');
  }
  steps.push('run migrations only if required by the restored version');
  if (req.runHealthChecks ?? true) steps.push('run health checks');

  return {
    targetInstanceId: req.targetInstanceId,
    backupId: req.backupId,
    mode: req.mode,
    preserveSecrets,
    generateNewSecrets,
    steps,
    preservedDuringStop: ['mysql_data', 'uploads', 'plugin_artifacts'],
    forbiddenCommands: ['docker compose down -v', 'docker volume rm <mysql_data>'],
  };
}
