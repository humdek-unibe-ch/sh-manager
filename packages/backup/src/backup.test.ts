// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { BackupManifest } from '@shm/schemas';
import { buildBackupManifest, makeBackupId, verifyBackupIntegrity } from './manifest.js';
import { planRestore, validateBackupForRestore, type RestoreRequest } from './restore.js';
import { planClone } from './clone.js';

const baseManifest: BackupManifest = buildBackupManifest({
  instanceId: 'website1',
  selfhelpVersion: '1.4.2',
  migrationVersion: 'Version20260605081254',
  plugins: [{ id: 'survey-js', version: '1.3.0' }],
  includedAreas: ['database', 'uploads', 'plugin_artifacts', 'manifest', 'lock'],
  files: [{ path: 'db.sql.gz', sha256: 'abc', bytes: 100 }],
  createdAt: '2026-06-05T10:00:00Z',
});

describe('backup manifest', () => {
  it('builds a deterministic backup id', () => {
    expect(makeBackupId('website1', new Date('2026-06-05T10:00:00Z'), 1)).toBe('backup-20260605-website1-001');
  });

  it('verifies integrity and detects mismatches', () => {
    expect(verifyBackupIntegrity(baseManifest, { 'db.sql.gz': 'abc' }).ok).toBe(true);
    const bad = verifyBackupIntegrity(baseManifest, { 'db.sql.gz': 'zzz' });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/mismatch/i);
  });
});

describe('validateBackupForRestore', () => {
  const required = ['database', 'uploads', 'manifest', 'lock'];

  it('accepts a matching, complete backup', () => {
    const req: RestoreRequest = { targetInstanceId: 'website1', backupId: baseManifest.backupId, mode: 'same_instance' };
    expect(validateBackupForRestore(req, baseManifest, required).ok).toBe(true);
  });

  it('refuses a backup belonging to a different instance', () => {
    const req: RestoreRequest = { targetInstanceId: 'website2', backupId: baseManifest.backupId, mode: 'same_instance' };
    const r = validateBackupForRestore(req, baseManifest, required);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/belongs to instance/);
  });

  it('allows cross-instance restore only under disaster-recovery import', () => {
    const req: RestoreRequest = {
      targetInstanceId: 'website2',
      backupId: baseManifest.backupId,
      mode: 'same_instance',
      disasterRecoveryImport: true,
    };
    expect(validateBackupForRestore(req, baseManifest, required).ok).toBe(true);
  });

  it('refuses when a required data area is missing', () => {
    const manifest = { ...baseManifest, includedAreas: ['database'] };
    const req: RestoreRequest = { targetInstanceId: 'website1', backupId: baseManifest.backupId, mode: 'same_instance' };
    const r = validateBackupForRestore(req, manifest, required);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/required data area/);
  });
});

describe('planRestore', () => {
  it('preserves volumes and secrets on same-instance restore', () => {
    const plan = planRestore(
      { targetInstanceId: 'website1', backupId: baseManifest.backupId, mode: 'same_instance' },
      baseManifest,
    );
    expect(plan.preserveSecrets).toBe(true);
    expect(plan.preservedDuringStop).toContain('mysql_data');
    expect(plan.forbiddenCommands.join(' ')).toContain('down -v');
  });

  it('generates new secrets on restore-as-clone', () => {
    const plan = planRestore(
      { targetInstanceId: 'website1-copy', backupId: baseManifest.backupId, mode: 'restore_as_clone', newDomain: 'copy.example.ch' },
      baseManifest,
    );
    expect(plan.generateNewSecrets).toBe(true);
    expect(plan.preserveSecrets).toBe(false);
  });
});

describe('planClone', () => {
  const sourceLock = {
    lockfileVersion: 1,
    generatedAt: '2026-06-05T10:00:00Z',
    registry: { id: 'x', url: 'https://r/', metadataSha256: 'sha256:a' },
    core: {
      version: '1.4.2',
      backendImageDigest: 'sha256:b',
      frontendImageDigest: 'sha256:f',
      schedulerImageDigest: 'sha256:s',
      workerImageDigest: 'sha256:w',
      migrationVersion: 'V1',
      pluginApiVersion: '2.1',
      signedPayloadSha256: 'sha256:p',
    },
    services: {
      mysql: { image: 'mysql:8.4', digest: 'sha256:m' },
      redis: { image: 'redis:7.2', digest: 'sha256:r' },
      mercure: { image: 'dunglas/mercure:0.18', digest: 'sha256:me' },
    },
    plugins: {},
  } as const;

  it('preserves versions and generates new secrets', () => {
    const plan = planClone(
      { sourceInstanceId: 'website1', targetInstanceId: 'website1-staging', targetDomain: 'staging.example.ch' },
      sourceLock,
    );
    expect(plan.preserveVersions).toBe(true);
    expect(plan.generateNewSecrets).toBe(true);
    expect(plan.newlyGeneratedSecrets).toContain('APP_SECRET');
  });

  it('refuses cloning onto the same id or domain', () => {
    expect(() =>
      planClone({ sourceInstanceId: 'a', targetInstanceId: 'a', targetDomain: 'x.example.ch' }, sourceLock),
    ).toThrow(/differ/);
    expect(() =>
      planClone(
        { sourceInstanceId: 'a', targetInstanceId: 'b', targetDomain: 'dup.example.ch', sourceDomain: 'dup.example.ch' },
        sourceLock,
      ),
    ).toThrow(/reuse the source domain/);
  });

  it('refuses to skip new-secret generation', () => {
    expect(() =>
      planClone(
        { sourceInstanceId: 'a', targetInstanceId: 'b', targetDomain: 'x.example.ch', generateNewSecrets: false },
        sourceLock,
      ),
    ).toThrow(/separate security boundary/);
  });
});
