// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Clone planning. A clone is a new, fully isolated security boundary that
 * preserves application content + versions but never shares secrets, volumes,
 * Docker project, domain, or route with the source.
 */
import type { InstanceLock } from '@shm/schemas';

export interface CloneRequest {
  sourceInstanceId: string;
  targetInstanceId: string;
  targetDomain: string;
  preserveVersionsFromLock?: boolean;
  generateNewSecrets?: boolean;
  copyUploads?: boolean;
  copyPluginArtifacts?: boolean;
  /** Source domain/port, used to assert the clone does not reuse routing. */
  sourceDomain?: string;
}

export interface ClonePlan {
  sourceInstanceId: string;
  targetInstanceId: string;
  targetDomain: string;
  preserveVersions: boolean;
  generateNewSecrets: true;
  copyUploads: boolean;
  copyPluginArtifacts: boolean;
  newlyGeneratedSecrets: string[];
  steps: string[];
}

export function planClone(req: CloneRequest, sourceLock: InstanceLock): ClonePlan {
  if (req.targetInstanceId === req.sourceInstanceId) {
    throw new Error('Clone target instance id must differ from the source.');
  }
  if (req.sourceDomain && req.targetDomain === req.sourceDomain) {
    throw new Error('Clone must not reuse the source domain/route.');
  }
  if (req.generateNewSecrets === false) {
    throw new Error('Clone must generate new secrets to be a separate security boundary.');
  }

  const preserveVersions = req.preserveVersionsFromLock ?? true;
  return {
    sourceInstanceId: req.sourceInstanceId,
    targetInstanceId: req.targetInstanceId,
    targetDomain: req.targetDomain,
    preserveVersions,
    generateNewSecrets: true,
    copyUploads: req.copyUploads ?? true,
    copyPluginArtifacts: req.copyPluginArtifacts ?? true,
    newlyGeneratedSecrets: [
      'APP_SECRET',
      'jwt_keypair',
      'jwt_passphrase',
      'mercure_jwt_secret',
      'db_password',
      'db_root_password',
      'redis_password',
    ],
    steps: [
      `create new isolated instance "${req.targetInstanceId}" (own networks/volumes/compose project)`,
      preserveVersions
        ? `pin core/plugin versions from source lock (core ${sourceLock.core.version})`
        : 'resolve latest compatible versions',
      'generate new secrets (no secret is copied from the source)',
      req.copyUploads ?? true ? 'copy uploads into the clone' : 'skip uploads',
      req.copyPluginArtifacts ?? true ? 'copy plugin artifacts into the clone' : 'skip plugin artifacts',
      'copy database into the clone (source remains running)',
      'write clone manifest + lock, update inventory',
      'run health checks',
    ],
  };
}
