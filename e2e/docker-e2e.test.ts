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
 *   5. scheduled backup (cron one-shot path) + GFS retention prune, live
 *   6. clone: new secrets + isolated state, source untouched and still healthy
 *   7. pre-migration rollback: a failed health check restores the prior version
 *   8. two-instance routing isolation: separate projects/volumes/secrets
 *   9. managed-mode plugin pipeline: unsigned install refused (fail closed),
 *      dev-signed install parked by the CMS -> drained by the manager ->
 *      failure propagated to a terminal CMS status; instance stays healthy
 *  10. remove modes: disable / remove-containers-keep-data / full-delete
 *  11. server purge: full teardown with backups retained + clean re-bootstrap
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { composeProjectName } from '@shm/docker';
import { ManifestStore, instancePaths, readInstanceSecrets } from '@shm/instances';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionDeps } from '@shm/app-actions';
import nacl from 'tweetnacl';
import {
  drainInstancePluginOperations,
  hasPendingPluginOperations,
  instanceBackup,
  instanceBackupScheduleSet,
  instanceClone,
  instanceHealth,
  instanceInstall,
  instanceRemove,
  instanceRestore,
  instanceUpdate,
  processInstanceOperations,
  serverInit,
  serverPurge,
  serverRunScheduledBackups,
} from '@shm/app-actions';
import { ComposeExecBackendOperationsClient } from '@shm/app-actions';
import { buildImages, defaultRepos } from './build-images.mjs';
import {
  E2E_KEY_ID,
  TEST_PLUGIN,
  buildTestRegistry,
  canonicalStringify,
  devKeyPair,
} from './build-test-registry.mjs';
import {
  E2E_ENABLED,
  composeDownQuietly,
  e2eDeps,
  exposeBackend,
  httpJson,
  loginAdmin,
  makeRoot,
  rmRoot,
  waitForBackendHealthy,
} from './harness.js';
import { serveRegistry } from './serve-registry.mjs';

const execFileAsync = promisify(execFile);

const ADMIN_EMAIL = 'qa.admin@selfhelp.test';
const ADMIN_NAME = 'QA Admin';
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
  let adminPwB = '';
  let backendB = '';

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
    // A dedicated instance at the base version. The manager loop is enabled by
    // the SHIPPED wiring alone: install generates the per-instance manager
    // token and injects it via secrets.env — nothing is hand-wired here.
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
    const secrets = await readInstanceSecrets(instancePaths(D, deps.root).secretsDir);
    expect(secrets?.managerToken?.length ?? 0).toBeGreaterThan(0);

    // Direct backend port ONLY for the CMS-admin simulation (login, request,
    // status reads) — the manager-loop transport below never uses it.
    const backendD = await exposeBackend(deps, D, PORTS.dBackend);
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

    // Manager: claim + execute the pending operation, write status back —
    // through the production-default exec transport (docker compose exec into
    // the backend container, authenticated with the container's own
    // install-generated SELFHELP_MANAGER_TOKEN). No HTTP client, no host-side
    // token handling.
    const client = new ComposeExecBackendOperationsClient({
      runner: deps.runner,
      instanceDir: instancePaths(D, deps.root).dir,
      instanceId: D,
    });
    const outcome = await processInstanceOperations(deps, D, client);
    expect(outcome.result).toBe('completed');
    if (outcome.result !== 'completed') throw new Error(`unexpected outcome: ${JSON.stringify(outcome)}`);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.report.ok).toBe(true);

    // The CMS reflects the terminal status + the manifest is bumped, and the
    // manager-loop visibility block proves the authenticated exec polls.
    const statusRes = await fetch(`${backendD}/cms-api/v1/admin/system/update/status`, {
      headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' },
    });
    const statusBody = (await statusRes.json()) as {
      data?: { status?: string; manager?: { configured?: boolean; last_seen_at?: string | null } };
    };
    expect(statusBody.data?.status).toBe('succeeded');
    expect(statusBody.data?.manager?.configured).toBe(true);
    expect(statusBody.data?.manager?.last_seen_at).toBeTruthy();
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

  it('scheduled backup + GFS retention prune run against the live instance', async () => {
    // Enable a due-now nightly schedule (00:00 has always passed today) with a
    // tight GFS window: 2 dailies, no weeklies/monthlies, 1-year max age.
    await instanceBackupScheduleSet(deps, A, {
      enabled: true,
      time: '00:00',
      retention: { daily: 2, weekly: 0, monthly: 0, maxAgeDays: 365 },
    });

    // Seed synthetic OLD nightlies (valid manifests, as if aged on disk) plus
    // one old manual backup that no automatic prune may ever touch.
    const day = 24 * 60 * 60 * 1000;
    const keepDaily = await seedAgedBackup(deps, A, new Date(Date.now() - 3 * day), 'scheduled');
    const pruneA = await seedAgedBackup(deps, A, new Date(Date.now() - 4 * day), 'scheduled');
    const pruneB = await seedAgedBackup(deps, A, new Date(Date.now() - 5 * day), 'scheduled');
    const manualOld = await seedAgedBackup(deps, A, new Date(Date.now() - 10 * day), 'manual');

    // One-shot run: exactly what cron / the systemd timer executes headlessly
    // (the persistent web UI drives the same per-instance path from its loop).
    const run = await serverRunScheduledBackups(deps);
    const entry = run.entries.find((e) => e.instanceId === A);
    expect(entry?.action, JSON.stringify(run.entries)).toBe('backup_taken');
    const scheduledId = entry!.backupId!;

    // The new backup is tagged `scheduled` and is genuinely restorable: the
    // restore validator re-hashes every file on disk against the manifest.
    const backupsDir = instancePaths(A, deps.root).backupsDir;
    const manifest = JSON.parse(
      await readFile(path.join(backupsDir, scheduledId, 'backup-manifest.json'), 'utf8'),
    ) as { origin?: string };
    expect(manifest.origin).toBe('scheduled');
    const check = await instanceRestore(deps, A, scheduledId);
    expect(check.validation.ok, check.validation.errors.join('; ')).toBe(true);

    // GFS prune (part of the scheduled run) deleted exactly the dailies beyond
    // the 2 newest distinct days; the manual backup is untouchable.
    expect(entry!.prunedCount).toBe(2);
    const remaining = await readdir(backupsDir);
    expect(remaining).toContain(scheduledId);
    expect(remaining).toContain(keepDaily);
    expect(remaining).toContain(manualOld);
    expect(remaining).not.toContain(pruneA);
    expect(remaining).not.toContain(pruneB);

    // Double-run guard against live state: today's occurrence is now covered.
    const again = await serverRunScheduledBackups(deps);
    expect(again.entries.find((e) => e.instanceId === A)?.action).toBe('skipped_not_due');

    // The instance survived the whole cycle untouched (online backup, no stop).
    expect((await instanceHealth(deps, A)).overall).toBe('healthy');
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
    adminPwB = res.adminPassword ?? '';
    backendB = await exposeBackend(deps, B, PORTS.bBackend);
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

  it('managed plugin pipeline: unsigned refused, signed request parked, manager drains it, failure propagates', async () => {
    // The manager-shipped wiring alone puts the instance in `managed` install
    // mode with the e2e signing key as the ONLY trusted plugin key — assert
    // both ends of that trust chain before exercising it.
    const adminToken = await loginAdmin(backendB, ADMIN_EMAIL, adminPwB);
    const list = await httpJson('GET', `${backendB}/cms-api/v1/admin/plugins`, { token: adminToken });
    expect(list.status).toBe(200);
    expect(list.json?.data?.installMode).toBe('managed');
    const { stdout: trustEnv } = await deps.runner.run(instancePaths(B, deps.root).dir, [
      'exec', '-T', 'backend', 'printenv', 'SELFHELP_PLUGIN_TRUSTED_KEYS',
    ]);
    expect(trustEnv).toContain(`${E2E_KEY_ID}=`);

    // Mirrors the registry-published test plugin: same id/version, connected
    // (composer-only) archive mode, a package that can never resolve — so the
    // composer step is the deliberate failure point AFTER the trust gates.
    const manifest = {
      id: TEST_PLUGIN.id,
      name: 'QA E2E No-op Plugin',
      description: 'Manager e2e: exercises the managed plugin pipeline.',
      version: TEST_PLUGIN.version,
      pluginApiVersion: '0.1.0',
      license: 'MPL-2.0',
      compatibility: { selfhelp: '>=0.1.0 <0.2.0', php: '^8.4' },
      security: { trustLevel: 'official', capabilities: [] },
    };

    // SECURITY (fail closed): with APP_ENV=prod and the manager-enforced
    // SELFHELP_PLUGIN_REQUIRE_SIGNATURE=true, an UNSIGNED manifest is refused
    // at request time — nothing is ever parked for the manager to drain.
    const unsigned = await httpJson('POST', `${backendB}/cms-api/v1/admin/plugins/install`, {
      token: adminToken,
      body: { source: 'paste', manifest },
    });
    expect(unsigned.status, unsigned.text).toBeGreaterThanOrEqual(400);
    expect(unsigned.text).toMatch(/signature/i);
    expect(await hasPendingPluginOperations(deps, B)).toBe(false);

    // A correctly DEV-SIGNED request: the canonical signed payload + Ed25519
    // signature use the exact builder contract the production registry signs
    // with (sorted-keys canonical JSON, byte-identical PHP/JS).
    const payloadInput = {
      pluginId: TEST_PLUGIN.id,
      version: TEST_PLUGIN.version,
      composer: { package: 'selfhelp-qa/e2e-noop', version: TEST_PLUGIN.version },
      runtime: { entrypointUrl: 'https://e2e.invalid/plugin.esm.js', format: 'esm' },
      checksums: { frontendEsm: `sha256:${'c'.repeat(64)}` },
      compatibility: manifest.compatibility,
      archive: { mode: 'connected' },
    };
    const signedPayload = canonicalStringify(payloadInput);
    const signature = Buffer.from(
      nacl.sign.detached(new Uint8Array(Buffer.from(signedPayload, 'utf8')), devKeyPair().secretKey),
    ).toString('base64');
    const signed = await httpJson('POST', `${backendB}/cms-api/v1/admin/plugins/install`, {
      token: adminToken,
      body: {
        source: 'paste',
        manifest,
        registryEntry: {
          signedPayload,
          signature,
          keyId: E2E_KEY_ID,
          composer: payloadInput.composer,
          runtime: payloadInput.runtime,
          checksums: payloadInput.checksums,
        },
      },
    });
    expect(signed.status, signed.text).toBe(202);
    expect(signed.json?.data?.installAction).toBe('install_dispatched');
    expect(signed.json?.data?.installMode).toBe('managed');
    const operationId = signed.json?.data?.id as number;
    expect(operationId).toBeTruthy();

    // The CMS worker stages the operation and PARKS it with a managed runbook
    // (managed mode: the CMS never runs composer itself). Observe it through
    // the manager's own production transport (compose exec into the backend).
    const deadline = Date.now() + 240_000;
    while (!(await hasPendingPluginOperations(deps, B))) {
      if (Date.now() > deadline) throw new Error('plugin operation was never parked for the manager');
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Drain as the manager. The composer step fails (unresolvable package) —
    // the deliberate failure path: outcome failed + the operation moved to a
    // terminal CMS status instead of being retried forever.
    const report = await drainInstancePluginOperations(deps, B);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]?.pluginId).toBe(TEST_PLUGIN.id);
    expect(report.outcomes[0]?.status).toBe('failed');

    // Failure propagated end to end: terminal status in the CMS, nothing left
    // parked, no plugin row created, and the instance is untouched.
    const op = await httpJson('GET', `${backendB}/cms-api/v1/admin/plugins/operations/${operationId}`, {
      token: adminToken,
    });
    expect(op.status).toBe(200);
    expect(op.json?.data?.status).toBe('cancelled');
    expect(await hasPendingPluginOperations(deps, B)).toBe(false);
    const after = await httpJson('GET', `${backendB}/cms-api/v1/admin/plugins`, { token: adminToken });
    const installedIds = ((after.json?.data?.plugins ?? []) as { pluginId?: string }[]).map((p) => p.pluginId);
    expect(installedIds).not.toContain(TEST_PLUGIN.id);
    expect((await instanceHealth(deps, B)).overall).toBe('healthy');
  }, 900_000);

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

  it('server purge tears everything down against real Docker, keeps backups, and allows a clean re-bootstrap', async () => {
    // A's backups dir is non-empty from the backup/scheduler scenarios — purge
    // must retain it (the operator's escape hatch) while deleting everything
    // else: containers, volumes, instance dirs, proxy, server + manager state.
    const backupsA = instancePaths(A, deps.root).backupsDir;
    const backupsBefore = await readdir(backupsA);
    expect(backupsBefore.length).toBeGreaterThan(0);

    // The typed confirmation is the ONLY thing standing before deletion.
    const blocked = await serverPurge(deps, {});
    expect(blocked.ok).toBe(false);
    expect(blocked.instancesRemoved).toEqual([]);

    const report = await serverPurge(deps, { confirm: 'purge selfhelp' });
    expect(report.ok, report.errors.join('; ')).toBe(true);
    expect(report.instancesRemoved).toEqual(expect.arrayContaining([A, B, C]));

    // Docker is actually clean: every instance volume is gone.
    const vols = await listVolumes();
    for (const id of [A, B, C, D]) expect(instanceVolumes(vols, id)).toHaveLength(0);

    // Backups survived byte-for-byte (same directory entries).
    expect((await readdir(backupsA)).sort()).toEqual([...backupsBefore].sort());

    // Server state is gone and the retained backup folders do NOT block a
    // fresh bootstrap — a purged server can be re-initialized immediately.
    const reinit = await serverInit(deps, { serverId: 'qa-e2e-reborn', mode: 'local' });
    const inventory = JSON.parse(await readFile(reinit.inventoryPath, 'utf8')) as {
      serverId: string;
      instances: unknown[];
    };
    expect(inventory.serverId).toBe('qa-e2e-reborn');
    expect(inventory.instances).toHaveLength(0);
  }, 900_000);
});

/** Read APP_SECRET from one instance's 0600 secret env (isolation assertion). */
async function readAppSecret(deps: ActionDeps, instanceId: string): Promise<string> {
  const file = path.join(instancePaths(instanceId, deps.root).secretsDir, 'secrets.env');
  const text = await readFile(file, 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('APP_SECRET='));
  return line ? line.slice('APP_SECRET='.length).trim() : '';
}

/**
 * Drops a synthetic AGED backup directory (valid, self-consistent manifest)
 * into the instance's backups dir — the on-disk shape of a real nightly that
 * happened days ago, used to exercise GFS retention against live state.
 */
async function seedAgedBackup(
  deps: ActionDeps,
  instanceId: string,
  createdAt: Date,
  origin: 'scheduled' | 'manual',
): Promise<string> {
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = `${createdAt.getFullYear()}${p(createdAt.getMonth() + 1)}${p(createdAt.getDate())}`;
  // Local-naive timestamp at 02:00 of that day (matches the retention engine's
  // local-day bucketing, like a real nightly run would).
  const createdAtIso = `${createdAt.getFullYear()}-${p(createdAt.getMonth() + 1)}-${p(createdAt.getDate())}T02:00:00`;
  const backupId = `backup-${ymd}-${instanceId}-001`;
  const dir = path.join(instancePaths(instanceId, deps.root).backupsDir, backupId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'database.sql'), '-- aged e2e seed dump\n', 'utf8');
  await writeFile(
    path.join(dir, 'backup-manifest.json'),
    JSON.stringify({
      backupManifestVersion: 1,
      backupId,
      instanceId,
      createdAt: createdAtIso,
      mode: 'online',
      origin,
      selfhelpVersion: '0.0.1',
      migrationVersion: 'V0',
      plugins: [],
      includedAreas: ['database'],
      files: [{ path: 'database.sql', sha256: `sha256:${'a'.repeat(64)}`, bytes: 24 }],
    }),
    'utf8',
  );
  return backupId;
}
