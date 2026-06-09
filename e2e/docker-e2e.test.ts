// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Real Docker end-to-end for the SelfHelp Manager, exercising the full operator
 * journey against locally-built `:e2e` images and a dev-signed, locally-served
 * `test`-channel registry. NOTHING here touches the public registry or any
 * production key, and every instance is disposable (volumes reaped on teardown).
 *
 * Gated: the suite is SKIPPED unless `SHM_E2E=1` (and Docker + the sibling
 * backend/frontend repos are present). It is therefore off the fast PR gate and
 * runs in `.github/workflows/e2e-docker.yml` (workflow_dispatch + nightly).
 *
 * Scenarios (a single ordered journey sharing disposable instances):
 *   1. fresh install + provision -> HTTP health + admin login
 *   2. manager-driven update base->next -> version bump + data/volume preserved
 *   3. CMS-driven update via the manager loop (request -> process -> succeeded)
 *   4. backup -> restore (same instance): secrets preserved, data restored
 *   5. clone: new secrets + isolated state, source untouched and still healthy
 *   6. pre-migration rollback: a failed health check restores the prior version
 *   7. two-instance routing isolation: separate projects/volumes/secrets
 *   8. remove modes: disable / remove-containers-keep-data / full-delete
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { composeProjectName } from '@shm/docker';
import { ManifestStore, instancePaths } from '@shm/instances';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionDeps } from '../apps/cli/src/actions.js';
import {
  instanceBackup,
  instanceClone,
  instanceHealth,
  instanceInstall,
  instanceRemove,
  instanceRestore,
  instanceUpdate,
  processInstanceOperations,
  serverInit,
} from '../apps/cli/src/actions.js';
import { HttpBackendOperationsClient } from '../apps/cli/src/operations-client.js';
import { buildImages, defaultRepos } from './build-images.mjs';
import { buildTestRegistry } from './build-test-registry.mjs';
import {
  E2E_ENABLED,
  composeDownQuietly,
  e2eDeps,
  exposeBackend,
  loginAdmin,
  makeRoot,
  rmRoot,
  setManagerToken,
  waitForBackendHealthy,
} from './harness.js';
import { serveRegistry } from './serve-registry.mjs';

const execFileAsync = promisify(execFile);

const ADMIN_EMAIL = 'qa.admin@selfhelp.test';
const ADMIN_NAME = 'QA Admin';
const MANAGER_TOKEN_D = 'qa-e2e-manager-token-d-0123456789';
const PROXY_NETWORK = 'selfhelp_proxy';

// Disposable instances + their published ports (frontend = manager BFF probe,
// backend = direct e2e API calls). High, uncommon ports to dodge collisions.
const A = 'qa-e2e-a';
const B = 'qa-e2e-b';
const C = 'qa-e2e-c';
const D = 'qa-e2e-d';
const PORTS = {
  aFrontend: 18080,
  aBackend: 18181,
  bFrontend: 18090,
  bBackend: 18182,
  cFrontend: 18100,
  cBackend: 18183,
  dFrontend: 18110,
  dBackend: 18184,
} as const;

/** docker volume ls -q, lowercased, with separators stripped for loose matching. */
async function listVolumes(): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', ['volume', 'ls', '--format', '{{.Name}}']);
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Volumes belonging to one instance's compose project (loose, separator-insensitive). */
function instanceVolumes(all: string[], instanceId: string): string[] {
  const needle = norm(composeProjectName(instanceId));
  return all.filter((v) => norm(v).includes(needle));
}

async function networkCreate(name: string): Promise<void> {
  await execFileAsync('docker', ['network', 'create', name]).catch(() => {
    // already exists (or a benign race) — fine.
  });
}

async function networkRemove(name: string): Promise<void> {
  await execFileAsync('docker', ['network', 'rm', name]).catch(() => {
    // best effort.
  });
}

async function manifestVersion(deps: ActionDeps, instanceId: string): Promise<string> {
  const m = await new ManifestStore(instanceId, deps.root).read();
  return m.versions.selfhelp;
}

/** Read the maintenance flag from the (maintenance-exempt) admin version route. */
async function maintenanceModeOf(backendBase: string, token: string): Promise<boolean> {
  const r = await fetch(`${backendBase}/cms-api/v1/admin/system/version`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const body = (await r.json()) as { data?: { maintenance_mode?: boolean } };
  return body.data?.maintenance_mode === true;
}

describe.skipIf(!E2E_ENABLED)('manager docker e2e (SHM_E2E)', () => {
  let deps: ActionDeps;
  let root: string;
  let registryUrl: string;
  let baseVersion: string;
  let nextVersion: string;
  let stopRegistry: (() => Promise<void>) | null = null;
  let adminPwA = '';
  let backendA = '';

  beforeAll(async () => {
    // 1) Build the four test images from the sibling repos (overridable via env).
    const repos = { ...defaultRepos() };
    if (process.env.SHM_BACKEND_REPO) repos.backend = process.env.SHM_BACKEND_REPO;
    if (process.env.SHM_FRONTEND_REPO) repos.frontend = process.env.SHM_FRONTEND_REPO;
    buildImages({ repos });

    // 2) Assemble + dev-sign a served test registry from the real image digests.
    const regDir = await mkdtemp(path.join(tmpdir(), 'shm-e2e-registry-'));
    const reg = buildTestRegistry({ out: regDir });
    baseVersion = reg.base;
    nextVersion = reg.next;
    const served = await serveRegistry(reg.dir, 0);
    registryUrl = served.url;
    stopRegistry = served.close;

    // 3) Manager root + real deps (dev trusted keys), proxy network + inventory.
    root = await makeRoot();
    deps = await e2eDeps(root, reg.trustedKeysPath);
    await serverInit(deps, { serverId: 'qa-e2e', mode: 'local' });
    await networkCreate(PROXY_NETWORK);
  }, 2_400_000);

  afterAll(async () => {
    if (deps) {
      for (const id of [A, B, C, D]) await composeDownQuietly(deps, id);
    }
    await networkRemove(PROXY_NETWORK);
    if (stopRegistry) await stopRegistry();
    if (root) await rmRoot(root);
  }, 300_000);

  it('fresh install + provision brings up a healthy stack with a working admin login', async () => {
    const res = await instanceInstall(deps, {
      instanceId: A,
      displayName: 'QA E2E A',
      mode: 'local',
      localPort: PORTS.aFrontend,
      registryUrl,
      channel: 'test',
      version: baseVersion,
      provision: true,
      adminEmail: ADMIN_EMAIL,
      adminName: ADMIN_NAME,
    });
    expect(res.version).toBe(baseVersion);
    expect(res.broughtUp).toBe(true);
    expect(res.provision?.ok).toBe(true);
    expect(typeof res.adminPassword).toBe('string');
    adminPwA = res.adminPassword ?? '';
    expect(adminPwA.length).toBeGreaterThan(0);

    // Manager-side verdict (exercises the real frontend BFF health path).
    expect((await instanceHealth(deps, A)).overall).toBe('healthy');

    // Direct backend access for the rest of the journey + a real admin login.
    backendA = await exposeBackend(deps, A, PORTS.aBackend);
    await waitForBackendHealthy(backendA);
    const token = await loginAdmin(backendA, ADMIN_EMAIL, adminPwA);
    expect(token.length).toBeGreaterThan(0);
  }, 1_200_000);

  it('manager-driven update bumps the version and preserves the MySQL data volume', async () => {
    expect(await manifestVersion(deps, A)).toBe(baseVersion);
    const volsBefore = instanceVolumes(await listVolumes(), A);
    expect(volsBefore.length).toBeGreaterThan(0);

    const r = await instanceUpdate(deps, A, { target: nextVersion, channel: 'test' });
    // Surface the plan/report on failure — an opaque `executed:false`/`ok:false`
    // is otherwise very hard to diagnose from CI logs alone.
    expect(r.executed, `update plan: ${JSON.stringify(r.plan)}`).toBe(true);
    expect(r.report?.ok, `update report: ${JSON.stringify(r.report)}`).toBe(true);
    expect(r.report?.rolledBack).toBe(false);

    expect(await manifestVersion(deps, A)).toBe(nextVersion);

    // The DB data volume must never be torn down by an update.
    const volsAfter = instanceVolumes(await listVolumes(), A);
    for (const v of volsBefore) expect(volsAfter).toContain(v);

    // Data preserved end to end: the same admin still authenticates post-update.
    await waitForBackendHealthy(backendA);
    const token = await loginAdmin(backendA, ADMIN_EMAIL, adminPwA);
    expect(token.length).toBeGreaterThan(0);
    expect((await instanceHealth(deps, A)).overall).toBe('healthy');
  }, 900_000);

  it('CMS-driven update runs through the manager loop to succeeded', async () => {
    // A dedicated instance at the base version + the manager loop enabled.
    const res = await instanceInstall(deps, {
      instanceId: D,
      displayName: 'QA E2E D',
      mode: 'local',
      localPort: PORTS.dFrontend,
      registryUrl,
      channel: 'test',
      version: baseVersion,
      provision: true,
      adminEmail: ADMIN_EMAIL,
      adminName: ADMIN_NAME,
    });
    const adminPwD = res.adminPassword ?? '';
    const backendD = await exposeBackend(deps, D, PORTS.dBackend);
    await setManagerToken(deps, D, MANAGER_TOKEN_D);
    await waitForBackendHealthy(backendD);

    // CMS: an admin requests the update (direct backend POST; CSRF is disabled).
    const adminToken = await loginAdmin(backendD, ADMIN_EMAIL, adminPwD);
    const reqRes = await fetch(`${backendD}/cms-api/v1/admin/system/update/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ target_version: nextVersion, preflight_id: 'e2e', accepted_migration_risk: false }),
    });
    expect(reqRes.status).toBe(202);
    const reqBody = (await reqRes.json()) as { data?: { operation_id?: string; status?: string } };
    expect(reqBody.data?.operation_id).toBeTruthy();
    expect(reqBody.data?.status).toBe('requested');

    // Manager: claim + execute the pending operation, write status back.
    const client = new HttpBackendOperationsClient({ backendBaseUrl: backendD, managerToken: MANAGER_TOKEN_D, instanceId: D });
    const outcome = await processInstanceOperations(deps, D, client);
    expect(outcome.result).toBe('completed');
    if (outcome.result !== 'completed') throw new Error(`unexpected outcome: ${JSON.stringify(outcome)}`);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.report.ok).toBe(true);

    // The CMS reflects the terminal status + the manifest is bumped.
    const statusRes = await fetch(`${backendD}/cms-api/v1/admin/system/update/status`, {
      headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' },
    });
    const statusBody = (await statusRes.json()) as { data?: { status?: string } };
    expect(statusBody.data?.status).toBe('succeeded');
    expect(await manifestVersion(deps, D)).toBe(nextVersion);
  }, 1_200_000);

  it('backup then restore preserves instance secrets and restores the data', async () => {
    const backup = await instanceBackup(deps, A, { mode: 'maintenance' });
    expect(backup.backupId).toBeTruthy();
    expect(backup.manifest.files.length).toBeGreaterThan(0);

    const restore = await instanceRestore(deps, A, backup.backupId, { mode: 'same_instance', apply: true });
    expect(restore.executed).toBe(true);
    // A same-instance restore keeps the existing security boundary (no new secrets).
    expect(restore.secretsRegenerated).toBe(false);
    expect(restore.health?.overall).toBe('healthy');

    // Identity preserved: the original admin credentials still work after restore.
    await waitForBackendHealthy(backendA);
    const token = await loginAdmin(backendA, ADMIN_EMAIL, adminPwA);
    expect(token.length).toBeGreaterThan(0);
  }, 900_000);

  it('clone produces an isolated copy and leaves the source untouched', async () => {
    const clone = await instanceClone(deps, A, C, {
      targetDomain: 'qa-e2e-c.localhost',
      targetLocalPort: PORTS.cFrontend,
      apply: true,
    });
    expect(clone.executed).toBe(true);
    expect(clone.health?.overall).toBe('healthy');

    // The clone is a distinct compose project with its own volumes.
    const all = await listVolumes();
    expect(instanceVolumes(all, C).length).toBeGreaterThan(0);
    expect(composeProjectName(C)).not.toBe(composeProjectName(A));

    // The clone copied the source data, so the source admin authenticates on it.
    const backendC = await exposeBackend(deps, C, PORTS.cBackend);
    await waitForBackendHealthy(backendC);
    expect((await loginAdmin(backendC, ADMIN_EMAIL, adminPwA)).length).toBeGreaterThan(0);

    // Source is untouched: still healthy, still on the updated version.
    expect((await instanceHealth(deps, A)).overall).toBe('healthy');
    expect(await manifestVersion(deps, A)).toBe(nextVersion);
  }, 900_000);

  it('a failed update health check rolls back to the previous version and clears maintenance', async () => {
    // Fresh instance at the base version (kept for the isolation + remove tests).
    const res = await instanceInstall(deps, {
      instanceId: B,
      displayName: 'QA E2E B',
      mode: 'local',
      localPort: PORTS.bFrontend,
      registryUrl,
      channel: 'test',
      version: baseVersion,
      provision: true,
      adminEmail: ADMIN_EMAIL,
      adminName: ADMIN_NAME,
    });
    const adminPwB = res.adminPassword ?? '';
    const backendB = await exposeBackend(deps, B, PORTS.bBackend);
    await waitForBackendHealthy(backendB);

    // Force the post-migration health check to fail -> executeUpdate rolls back.
    const failHealthDeps: ActionDeps = {
      ...deps,
      probeHealth: async () => [
        { service: 'backend', ok: false, detail: 'forced e2e failure', required: true },
        { service: 'frontend', ok: false, detail: 'forced e2e failure', required: true },
      ],
    };
    const r = await instanceUpdate(failHealthDeps, B, { target: nextVersion, channel: 'test' });
    expect(r.executed).toBe(true);
    expect(r.report?.ok).toBe(false);
    expect(r.report?.rolledBack).toBe(true);
    // Non-destructive migrations -> a clean rollback, no manual restore required.
    expect(r.report?.requiresManualRestore).toBeFalsy();

    // Config restored to the previous version, stack healthy again (real probe).
    expect(await manifestVersion(deps, B)).toBe(baseVersion);
    await waitForBackendHealthy(backendB);
    expect((await instanceHealth(deps, B)).overall).toBe('healthy');

    // Maintenance was cleared on the rollback path (never left stuck).
    const adminToken = await loginAdmin(backendB, ADMIN_EMAIL, adminPwB);
    expect(await maintenanceModeOf(backendB, adminToken)).toBe(false);
  }, 900_000);

  it('two instances are routing-isolated (distinct projects, volumes, secrets)', async () => {
    // A (updated) and B (rolled back) both run concurrently and healthily.
    expect((await instanceHealth(deps, A)).overall).toBe('healthy');
    expect((await instanceHealth(deps, B)).overall).toBe('healthy');

    expect(composeProjectName(A)).not.toBe(composeProjectName(B));

    const all = await listVolumes();
    const volsA = new Set(instanceVolumes(all, A));
    const volsB = instanceVolumes(all, B);
    expect(volsA.size).toBeGreaterThan(0);
    expect(volsB.length).toBeGreaterThan(0);
    for (const v of volsB) expect(volsA.has(v)).toBe(false);

    // Per-instance secrets are independent (different APP_SECRET).
    const secA = await readAppSecret(deps, A);
    const secB = await readAppSecret(deps, B);
    expect(secA).not.toBe(secB);
    expect(secA.length).toBeGreaterThan(0);
  }, 300_000);

  it('remove modes stop/clean one instance while another stays healthy', async () => {
    // disable: containers stopped, volumes + dir kept.
    const disable = await instanceRemove(deps, D, { mode: 'disable' });
    expect(disable.ok).toBe(true);
    expect(disable.executed).toBe(true);
    expect((await instanceHealth(deps, A)).overall).toBe('healthy');

    // full_delete: requires the exact typed confirmation ("delete <id>") +
    // removes volumes + dir.
    const purge = await instanceRemove(deps, D, { mode: 'full_delete', confirm: `delete ${D}`, deleteVolumes: true });
    expect(purge.ok).toBe(true);
    expect(purge.executed).toBe(true);
    expect(instanceVolumes(await listVolumes(), D).length).toBe(0);

    // The surviving instance is unaffected by removing another.
    expect((await instanceHealth(deps, A)).overall).toBe('healthy');
  }, 600_000);
});

/** Read APP_SECRET from one instance's 0600 secret env (isolation assertion). */
async function readAppSecret(deps: ActionDeps, instanceId: string): Promise<string> {
  const file = path.join(instancePaths(instanceId, deps.root).secretsDir, 'secrets.env');
  const text = await readFile(file, 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('APP_SECRET='));
  return line ? line.slice('APP_SECRET='.length).trim() : '';
}
