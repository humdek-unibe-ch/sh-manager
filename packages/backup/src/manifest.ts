// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { BackupManifest, BackupOrigin, InstalledPlugin } from '@shm/schemas';

export const REQUIRED_BACKUP_AREAS = ['database', 'uploads', 'plugin_artifacts', 'manifest', 'lock'] as const;

export interface BackupInput {
  instanceId: string;
  selfhelpVersion: string;
  migrationVersion: string;
  plugins: InstalledPlugin[];
  mode?: 'maintenance' | 'online';
  origin?: BackupOrigin;
  includedAreas: string[];
  files: { path: string; sha256: string; bytes: number }[];
  createdAt?: string;
  seq?: number;
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

export function makeBackupId(instanceId: string, date: Date = new Date(), seq = 1): string {
  return `backup-${yyyymmdd(date)}-${instanceId}-${String(seq).padStart(3, '0')}`;
}

/**
 * Next free same-day sequence number, given the existing backup directory
 * names. Same-day backups previously all defaulted to seq 1 and silently
 * overwrote each other; callers now pick max(existing)+1 instead. Ids of
 * other days/instances and non-backup names are ignored.
 */
export function nextBackupSeq(existingIds: string[], instanceId: string, date: Date): number {
  const prefix = `backup-${yyyymmdd(date)}-${instanceId}-`;
  let max = 0;
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (!/^\d{3,}$/.test(rest)) continue;
    const n = parseInt(rest, 10);
    if (n > max) max = n;
  }
  return max + 1;
}

export function buildBackupManifest(input: BackupInput): BackupManifest {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    backupManifestVersion: 1,
    backupId: makeBackupId(input.instanceId, new Date(createdAt), input.seq ?? 1),
    instanceId: input.instanceId,
    createdAt,
    mode: input.mode ?? 'maintenance',
    origin: input.origin ?? 'manual',
    selfhelpVersion: input.selfhelpVersion,
    migrationVersion: input.migrationVersion,
    plugins: input.plugins,
    includedAreas: input.includedAreas,
    files: input.files,
  };
}

export interface IntegrityResult {
  ok: boolean;
  errors: string[];
}

/** Verifies recorded file hashes against freshly computed hashes. */
export function verifyBackupIntegrity(
  manifest: BackupManifest,
  actualHashes: Record<string, string>,
): IntegrityResult {
  const errors: string[] = [];
  if (manifest.files.length === 0) errors.push('Backup manifest lists no files.');
  for (const f of manifest.files) {
    const actual = actualHashes[f.path];
    if (actual === undefined) {
      errors.push(`Missing file for integrity check: ${f.path}`);
    } else if (actual.toLowerCase().replace(/^sha256:/, '') !== f.sha256.toLowerCase().replace(/^sha256:/, '')) {
      errors.push(`Checksum mismatch: ${f.path}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
