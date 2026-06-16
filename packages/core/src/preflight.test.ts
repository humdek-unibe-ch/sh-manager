// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { DatabaseMigrationMetadata } from '@shm/schemas';
import { runPreflight, type PreflightResourceFacts } from './preflight.js';

const GiB = 1024 * 1024 * 1024;

const healthyResources: PreflightResourceFacts = {
  requiredPortsFree: [{ port: 80, free: true }, { port: 443, free: true }],
  diskBytesFree: 50 * GiB,
  memoryBytesTotal: 8 * GiB,
  cpuCount: 4,
  dockerAvailable: true,
  dockerComposeAvailable: true,
};

const safeDb: DatabaseMigrationMetadata = {
  migrationRange: 'V1..V2',
  destructive: false,
  requiresBackup: true,
  manualConfirmationRequired: false,
};

describe('runPreflight', () => {
  it('passes with healthy resources', () => {
    const r = runPreflight({ instanceId: 'website1', currentVersion: '1.4.0', targetVersion: '1.5.0', resources: healthyResources, database: safeDb });
    expect(r.status).toBe('ok');
    expect(r.instanceId).toBe('website1');
  });

  it('blocks when docker is missing or disk is insufficient', () => {
    const r = runPreflight({
      instanceId: 'website1',
      currentVersion: '1.4.0',
      targetVersion: '1.5.0',
      resources: { ...healthyResources, dockerAvailable: false, diskBytesFree: 1 * GiB },
      database: safeDb,
    });
    expect(r.status).toBe('blocked');
    expect(r.checks.find((c) => c.code === 'docker.available')?.severity).toBe('error');
    expect(r.checks.find((c) => c.code === 'resources.disk')?.severity).toBe('error');
  });

  it('blocks when a required port is busy', () => {
    const r = runPreflight({
      instanceId: 'website1',
      currentVersion: '1.4.0',
      targetVersion: '1.5.0',
      resources: { ...healthyResources, requiredPortsFree: [{ port: 443, free: false }] },
      database: safeDb,
    });
    expect(r.status).toBe('blocked');
    const portMsg = r.checks.find((c) => c.code === 'resources.ports')?.message ?? '';
    expect(portMsg).toMatch(/443/);
    // The message must be actionable: name the usual culprit (another web
    // server) and the fix, since a busy 80/443 is the #1 "domain doesn't load".
    expect(portMsg).toMatch(/apache/i);
    expect(portMsg).toMatch(/Traefik proxy/i);
  });

  it('warns when the host kernel vm.overcommit_memory is 0 (the Redis warning) with the host fix', () => {
    const r = runPreflight({
      instanceId: 'website1',
      currentVersion: '1.5.5',
      targetVersion: '1.5.6',
      resources: { ...healthyResources, overcommitMemory: 0 },
      database: safeDb,
    });
    expect(r.status).toBe('warning');
    const check = r.checks.find((c) => c.code === 'resources.overcommit');
    expect(check?.severity).toBe('warning');
    // Actionable: names the sysctl and the host command, not a vague note.
    expect(check?.message).toMatch(/vm\.overcommit_memory/);
    expect(check?.message).toMatch(/sysctl vm\.overcommit_memory=1/);
  });

  it('does not raise the overcommit advisory when it is 1 or could not be read', () => {
    const enabled = runPreflight({
      instanceId: 'website1',
      currentVersion: '1.5.5',
      targetVersion: '1.5.6',
      resources: { ...healthyResources, overcommitMemory: 1 },
      database: safeDb,
    });
    expect(enabled.checks.some((c) => c.code === 'resources.overcommit')).toBe(false);

    // Unset (non-Linux host / unreadable /proc) must stay silent, not warn.
    const unknown = runPreflight({
      instanceId: 'website1',
      currentVersion: '1.5.5',
      targetVersion: '1.5.6',
      resources: healthyResources,
      database: safeDb,
    });
    expect(unknown.checks.some((c) => c.code === 'resources.overcommit')).toBe(false);
    expect(unknown.status).toBe('ok');
  });

  it('blocks an impossible direct-upgrade path', () => {
    const r = runPreflight({ instanceId: 'website1', currentVersion: '1.0.0', targetVersion: '1.5.0', resources: healthyResources, database: safeDb, canDirectUpgrade: false });
    expect(r.status).toBe('blocked');
    expect(r.checks.some((c) => c.code === 'upgrade.path')).toBe(true);
  });

  it('warns (not blocks) for destructive migrations and never promises automatic post-destructive rollback', () => {
    const r = runPreflight({
      instanceId: 'website1',
      currentVersion: '1.4.0',
      targetVersion: '1.5.0',
      resources: healthyResources,
      database: { ...safeDb, destructive: true, manualConfirmationRequired: true, automaticRollback: 'snapshot' },
    });
    expect(r.status).toBe('warning');
    expect(r.database.destructive).toBe(true);
    // MVP policy: automatic rollback is only safe BEFORE migrations. Even when
    // the registry advertises an automaticRollback hint, the manager must not
    // claim automatic rollback after a destructive migration has run.
    expect(r.rollback.automaticBeforeMigrations).toBe(true);
    expect(r.rollback.automaticAfterDestructiveMigrations).toBe(false);
  });

  it('blocks on advisory, compatibility, and drift inputs', () => {
    const r = runPreflight({
      instanceId: 'website1',
      currentVersion: '1.4.0',
      targetVersion: '1.5.0',
      resources: healthyResources,
      database: safeDb,
      advisoryBlocks: ['CVE-2026-1 affects 1.5.0'],
      compatibilityBlocks: ['plugin survey-js incompatible'],
      driftBlocks: ['unmanaged dir found'],
    });
    expect(r.status).toBe('blocked');
    expect(r.checks.filter((c) => c.severity === 'error').length).toBeGreaterThanOrEqual(3);
  });
});
