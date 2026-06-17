// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Diagnostic + recovery actions: redacted support bundles, on-demand container
 * and proxy logs, manifest repair, plugin safe-mode toggling, and crash-loop
 * plugin recovery.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateInstanceManifest } from '@shm/schemas';
import type { BackupManifest, InstanceManifest, InstanceMode } from '@shm/schemas';
import { buildInstanceRouting, composeCommands, composeProjectName } from '@shm/docker';
import {
  InventoryStore,
  LockStore,
  ManifestStore,
  ensureManagerToken,
  instancePaths,
  instancesDir,
  proxyDir,
  readInstanceSecrets,
  writeInstanceSecrets,
} from '@shm/instances';
import { assembleSupportBundle, redactString } from '@shm/support';
import { parseEnv, readManifestFriendly, type ActionDeps, type PluginDrainOverrides } from './shared.js';
import { drainInstancePluginOperations } from './operations.js';

// ---------------------------------------------------------------------------
// instance support-bundle (redacted)
// ---------------------------------------------------------------------------

export async function instanceSupportBundle(
  deps: ActionDeps,
  instanceId: string,
): Promise<{ dir: string; files: string[] }> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const lock = await new LockStore(instanceId, deps.root).read();
  const paths = instancePaths(instanceId, deps.root);

  const env = parseEnv(await readFile(paths.envPath, 'utf8').catch(() => ''));

  const composeStatus = await deps.runner
    .run(paths.dir, composeCommands.ps())
    .then((r) => r.stdout)
    .catch(() => '');
  const logs: { backend?: string; frontend?: string; scheduler?: string; worker?: string } = {};
  for (const svc of ['backend', 'frontend', 'scheduler', 'worker'] as const) {
    logs[svc] = await deps.runner
      .run(paths.dir, [...composeCommands.logs(), svc])
      .then((r) => r.stdout)
      .catch(() => '');
  }

  const bundle = assembleSupportBundle({
    instanceId,
    managerVersion: deps.managerVersion,
    schemaVersions: { manifest: manifest.manifestVersion, lock: lock.lockfileVersion, inventory: 1 },
    manifest,
    lock,
    versionSummary: {
      selfhelp: manifest.versions.selfhelp,
      backend: manifest.versions.backend,
      frontend: manifest.versions.frontend,
      migrationVersion: lock.core.migrationVersion,
    },
    installedPlugins: manifest.installedPlugins,
    env,
    healthResults: {},
    composeStatus,
    logs,
  });

  const stamp = (deps.now?.() ?? new Date().toISOString()).replace(/[:.]/g, '-');
  const dir = path.join(paths.logsDir, `support-bundle-${stamp}`);
  await mkdir(dir, { recursive: true });
  for (const f of bundle.files) await writeFile(path.join(dir, f.name), f.content);

  return { dir, files: bundle.files.map((f) => f.name) };
}

// ---------------------------------------------------------------------------
// instance logs (read recent container logs on demand, redacted)
// ---------------------------------------------------------------------------

/**
 * Services whose container logs an operator can read from the manager. Ordered
 * for the UI picker; `volume-init` is intentionally excluded (a one-shot init
 * container with no useful runtime log).
 */
export const LOG_SERVICES = [
  'backend',
  'frontend',
  'worker',
  'scheduler',
  'mysql',
  'redis',
  'mercure',
  'mailpit',
] as const;
export type LogService = (typeof LOG_SERVICES)[number];

/** Bounds for the `--tail` line count (UI default: 200). */
const LOG_TAIL_MIN = 1;
const LOG_TAIL_MAX = 2000;
const LOG_TAIL_DEFAULT = 200;

export interface InstanceLogsResult {
  instanceId: string;
  service: LogService;
  /** Number of trailing lines requested (after clamping). */
  tail: number;
  /** Redacted log text — the running container's stdout/stderr. */
  text: string;
  /** ISO timestamp the logs were read at (for the UI). */
  readAt: string;
}

function clampLogTail(tail: number | undefined): number {
  if (tail === undefined || !Number.isFinite(tail)) return LOG_TAIL_DEFAULT;
  return Math.max(LOG_TAIL_MIN, Math.min(LOG_TAIL_MAX, Math.floor(tail)));
}

/**
 * Turns a `docker compose logs <service>` failure into an operator-readable
 * message. Compose's own "no such service" is the common, confusing case: the
 * requested service is simply not part of THIS instance's compose project
 * (e.g. `mailpit`, which only exists for local-mode instances that use the
 * bundled test mailbox, or any service on an instance whose compose predates a
 * later-added service). Translate it instead of surfacing the raw error.
 */
function logReadFailureMessage(service: LogService, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (/no such service/i.test(detail)) {
    if (service === 'mailpit') {
      return (
        `This instance has no "mailpit" service. Mailpit is the bundled test mailbox that only runs ` +
        `for local-mode instances; it is a sink and never relays mail to a real server. To send real ` +
        `outbound mail (e.g. through a campus/UniBE relay without a password), set the instance's SMTP ` +
        `DSN in the mailer settings — for example smtp://smtp.unibe.ch:25 — rather than reading mailpit logs.`
      );
    }
    return `This instance has no "${service}" service, so there are no logs to read for it.`;
  }
  return `Could not read logs for "${service}": ${detail}`;
}

/**
 * Reads the recent container logs for ONE service of an instance via
 * `docker compose logs --tail=<n> <service>`, redacting any secret-looking
 * content before returning.
 *
 * These are the running container's stdout/stderr — exactly what Symfony (backend)
 * and Next.js (frontend) print on error — surfaced on demand so an operator can
 * diagnose an instance from the manager without shelling into the server. It is
 * the same source the support bundle captures.
 *
 * Note on persistence: Docker keeps these logs for the lifetime of the container,
 * so they survive a restart but are reset when the container is recreated (e.g. by
 * an update). For a portable, point-in-time copy use the support bundle before a
 * risky change.
 */
export async function instanceLogs(
  deps: ActionDeps,
  instanceId: string,
  opts: { service?: LogService; tail?: number } = {},
): Promise<InstanceLogsResult> {
  const service: LogService = opts.service ?? 'backend';
  if (!LOG_SERVICES.includes(service)) {
    throw new Error(`Unknown service "${service}". Choose one of: ${LOG_SERVICES.join(', ')}.`);
  }
  const tail = clampLogTail(opts.tail);
  // Confirm the instance exists first, so a bad id is a clear error rather than a
  // raw compose failure.
  await readManifestFriendly(deps, instanceId);
  const paths = instancePaths(instanceId, deps.root);
  const raw = await deps.runner
    .run(paths.dir, [...composeCommands.logs(tail), service])
    .then((r) => r.stdout || r.stderr)
    .catch((err: unknown) => logReadFailureMessage(service, err));
  return {
    instanceId,
    service,
    tail,
    text: redactString(raw),
    readAt: deps.now?.() ?? new Date().toISOString(),
  };
}

export interface ProxyLogsResult {
  /** Number of trailing lines requested (after clamping). */
  tail: number;
  /** Redacted Traefik log text. */
  text: string;
  /** ISO timestamp the logs were read at. */
  readAt: string;
}

/**
 * Reads the shared Traefik proxy's recent logs via
 * `docker compose -f <root>/proxy/compose.yaml logs --tail=<n>`, redacted.
 *
 * Surfaced in the manager (CLI `server logs`, web console) so an operator can
 * diagnose edge/routing/TLS problems — e.g. the Docker-provider "client version
 * 1.24 is too old" failure, ACME/Let's Encrypt errors, or "no router for host" —
 * without shelling into the server. A no-op-safe message is returned (never a
 * throw) when the proxy has not been started yet.
 */
export async function serverProxyLogs(deps: ActionDeps, opts: { tail?: number } = {}): Promise<ProxyLogsResult> {
  const tail = clampLogTail(opts.tail);
  const raw = await deps.runner
    .run(proxyDir(deps.root), composeCommands.logs(tail))
    .then((r) => r.stdout || r.stderr)
    .catch((err: unknown) => `Could not read proxy logs: ${err instanceof Error ? err.message : String(err)}`);
  return {
    tail,
    text: redactString(raw),
    readAt: deps.now?.() ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// instance repair (reconstruct a missing/invalid manifest)
// ---------------------------------------------------------------------------

export interface RepairOutcome {
  repaired: boolean;
  /** Where the manifest came from: already valid, a backup snapshot, or rebuilt. */
  source: 'intact' | 'backup' | 'reconstructed';
  manifestPath: string;
  notes: string[];
}

/**
 * Repairs an instance whose `selfhelp.instance.json` is missing or invalid
 * (the "instance is gone" failure). Sources, in order of fidelity:
 *
 * 1. Intact manifest → only re-register a missing inventory entry.
 * 2. The newest backup's manifest snapshot (every backup stores a full copy).
 * 3. Reconstruction from inventory entry + lock file + compose file (versions
 *    from the lock, images/mode/port from compose, domain from the inventory).
 *
 * Never touches containers, volumes or backups. Secrets are only ever
 * extended: a missing per-instance manager token is minted (same backfill as
 * `instanceUpdate`); existing secret values are never changed.
 */
export async function instanceRepair(deps: ActionDeps, instanceId: string): Promise<RepairOutcome> {
  const store = new ManifestStore(instanceId, deps.root);
  const paths = instancePaths(instanceId, deps.root);
  const invStore = new InventoryStore(deps.root);
  const notes: string[] = [];
  const now = deps.now?.() ?? new Date().toISOString();

  const dirExists = await stat(paths.dir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  const inventory = await invStore.read().catch(() => null);
  const entry = inventory?.instances.find((i) => i.instanceId === instanceId) ?? null;
  if (!dirExists && !entry) {
    throw new Error(
      `Instance "${instanceId}" has no directory under ${instancesDir(deps.root)} and no inventory entry — nothing to repair. ` +
        'To recover a fully deleted instance, restore it from a backup copy or reinstall it.',
    );
  }

  // Backfill the per-instance manager token for pre-token installs (mirrors
  // the instanceUpdate backfill). Additive only — an existing token is never
  // changed; the backend picks it up when its container is next recreated.
  let mintedToken = false;
  const onDiskSecrets = await readInstanceSecrets(paths.secretsDir);
  if (onDiskSecrets !== null) {
    const ensured = ensureManagerToken(onDiskSecrets);
    if (ensured.minted) {
      await writeInstanceSecrets(paths.secretsDir, ensured.secrets, deps.secretIO);
      mintedToken = true;
      notes.push(
        'Minted the missing per-instance manager token (SELFHELP_MANAGER_TOKEN); recreate the backend container to enable the CMS-requested update loop.',
      );
    }
  }

  // 1. Intact manifest: the only possible repair is a missing inventory entry.
  const intact = await store.read().catch(() => null);
  if (intact) {
    if (!entry && inventory) {
      await invStore.upsertInstance(
        {
          instanceId,
          domain: intact.domain,
          path: paths.dir,
          composeProject: composeProjectName(instanceId),
          status: 'active',
        },
        inventory,
      );
      notes.push('Manifest is valid; re-registered the instance in the server inventory.');
      return { repaired: true, source: 'intact', manifestPath: store.path, notes };
    }
    if (!mintedToken) notes.push('Manifest and inventory are consistent; nothing to repair.');
    return { repaired: mintedToken, source: 'intact', manifestPath: store.path, notes };
  }

  // 2. Newest backup snapshot wins: it is a validated, full-fidelity copy.
  const snapshot = await newestBackupManifestSnapshot(paths.backupsDir, instanceId);
  let manifest: InstanceManifest;
  let source: 'backup' | 'reconstructed';
  if (snapshot) {
    manifest = { ...snapshot.manifest, updatedAt: now };
    source = 'backup';
    notes.push(
      `Restored the manifest from backup ${snapshot.backupId} (instance state as of ${snapshot.manifest.updatedAt}); ` +
        'review it if the instance changed since that backup.',
    );
  } else {
    manifest = await reconstructManifestFromState(deps, instanceId, entry?.domain ?? null, now);
    source = 'reconstructed';
    notes.push(
      'Reconstructed the manifest from the inventory + lock + compose file. Display name, creation time and ' +
        'registry channel are best-effort defaults — review them.',
    );
  }

  await store.write(manifest);
  notes.push(`Wrote ${store.path}.`);

  // 3. Make sure the inventory knows the instance again.
  if (inventory && !entry) {
    await invStore.upsertInstance(
      {
        instanceId,
        domain: manifest.domain,
        path: paths.dir,
        composeProject: composeProjectName(instanceId),
        status: 'active',
      },
      inventory,
    );
    notes.push('Re-registered the instance in the server inventory.');
  }
  return { repaired: true, source, manifestPath: store.path, notes };
}

/** Newest backup directory containing a valid manifest snapshot for this instance. */
async function newestBackupManifestSnapshot(
  backupsDir: string,
  instanceId: string,
): Promise<{ backupId: string; createdAt: string; manifest: InstanceManifest } | null> {
  const names = await readdir(backupsDir, { withFileTypes: true })
    .then((entries) => entries.filter((d) => d.isDirectory()).map((d) => d.name))
    .catch(() => [] as string[]);
  const candidates: { backupId: string; createdAt: string; manifest: InstanceManifest }[] = [];
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(backupsDir, name, 'selfhelp.instance.json'), 'utf8'));
      const v = validateInstanceManifest(raw);
      if (!v.valid || !v.value || v.value.instanceId !== instanceId) continue;
      const backupMeta = JSON.parse(
        await readFile(path.join(backupsDir, name, 'backup-manifest.json'), 'utf8'),
      ) as BackupManifest;
      candidates.push({ backupId: name, createdAt: backupMeta.createdAt ?? v.value.updatedAt, manifest: v.value });
    } catch {
      // Unreadable backup folder: skip it as a repair source.
    }
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return candidates[0] ?? null;
}

/**
 * Rebuilds a manifest with no backup snapshot available: versions/plugins from
 * the lock file, images + mode + local port from the generated compose file,
 * domain from the inventory entry. Throws with recovery guidance when even
 * these sources are gone.
 */
async function reconstructManifestFromState(
  deps: ActionDeps,
  instanceId: string,
  inventoryDomain: string | null,
  now: string,
): Promise<InstanceManifest> {
  const paths = instancePaths(instanceId, deps.root);
  const lock = await new LockStore(instanceId, deps.root).read().catch(() => null);
  const composeText = await readFile(paths.composePath, 'utf8').catch(() => null);
  if (!lock || composeText === null) {
    throw new Error(
      `Cannot repair "${instanceId}": no backup manifest snapshot and ${lock ? 'no compose file' : 'no lock file'} ` +
        `under ${paths.dir}. Restore the instance from a backup or reinstall it.`,
    );
  }

  const compose = parseYaml(composeText) as {
    services?: Record<string, { image?: string; ports?: unknown[] }>;
  };
  const services = compose.services ?? {};
  const image = (name: string): string => {
    const img = services[name]?.image;
    if (!img) throw new Error(`Cannot repair "${instanceId}": the compose file declares no image for service "${name}".`);
    return img;
  };
  const images = {
    backend: image('backend'),
    frontend: image('frontend'),
    scheduler: image('scheduler'),
    worker: image('worker'),
    mysql: image('mysql'),
    redis: image('redis'),
    mercure: image('mercure'),
  };

  // The generated compose publishes a localhost port ONLY in local mode
  // (production routes through the shared proxy network instead).
  const portEntry = (services.frontend?.ports ?? []).find((p): p is string => typeof p === 'string') ?? null;
  const mode: InstanceMode = portEntry ? 'local' : 'production';
  const localPort = portEntry ? Number(portEntry.split(':')[1]) : undefined;
  const domain = inventoryDomain || (mode === 'local' && localPort !== undefined ? `localhost:${localPort}` : '');
  if (domain === '') {
    throw new Error(
      `Cannot repair "${instanceId}": the server inventory has no domain for this production instance. ` +
        'Restore from a backup, or re-register the instance first.',
    );
  }
  const publicFrontendUrl = mode === 'production' ? `https://${domain}` : `http://localhost:${localPort}`;
  const frontendVersion = images.frontend.includes(':')
    ? images.frontend.slice(images.frontend.lastIndexOf(':') + 1)
    : lock.core.version;

  return {
    manifestVersion: 1,
    instanceId,
    displayName: instanceId,
    domain,
    mode,
    createdAt: now,
    updatedAt: now,
    registry: { id: lock.registry.id, url: lock.registry.url, channel: 'stable' },
    versions: {
      selfhelp: lock.core.version,
      backend: lock.core.version,
      frontend: frontendVersion,
      scheduler: lock.core.version,
      worker: lock.core.version,
      pluginApi: lock.core.pluginApiVersion,
    },
    images,
    routing: buildInstanceRouting({
      instanceId,
      mode,
      selfhelpVersion: lock.core.version,
      frontendVersion,
      publicFrontendUrl,
    }),
    installedPlugins: Object.entries(lock.plugins).map(([id, p]) => ({ id, version: p.version })),
  };
}

// ---------------------------------------------------------------------------
// instance safe-mode (delegates to the canonical backend console command)
// ---------------------------------------------------------------------------

// The backend's safe-mode marker file: while it exists the kernel boots with
// core bundles only (no plugins). `selfhelp:safe-mode --enable/--disable`
// creates/removes it — but that console command cannot run when a half-removed
// plugin makes the kernel fatal at boot ("Class ...Bundle not found"). So when
// the console call fails we toggle the marker directly over a shell; that is the
// one step that revives a crash-looping backend (see instancePluginRecover).
const SAFE_MODE_MARKER = '/app/var/plugin_safe_mode.lock';

// System safe mode boots the backend with core bundles only (no plugins).
// `selfhelp:safe-mode` is the canonical command; it is a thin alias over the
// plugin safe-mode mechanism (var/plugin_safe_mode.lock), so the legacy
// `selfhelp:plugin:safe-mode` keeps working too. Resilient: if the console
// cannot boot (a dangling plugin bundle fatals the kernel), the marker file is
// created/removed directly so safe mode can still be toggled.
export async function instanceSafeMode(deps: ActionDeps, instanceId: string, enable: boolean): Promise<void> {
  const paths = instancePaths(instanceId, deps.root);
  try {
    await deps.runner.run(paths.dir, [
      'exec',
      '-T',
      'backend',
      'php',
      'bin/console',
      'selfhelp:safe-mode',
      enable ? '--enable' : '--disable',
    ]);
  } catch {
    await deps.runner.run(paths.dir, [
      'exec',
      '-T',
      'backend',
      'sh',
      '-c',
      enable ? `mkdir -p /app/var && : > ${SAFE_MODE_MARKER}` : `rm -f ${SAFE_MODE_MARKER}`,
    ]);
  }
}

export interface PluginRecoverResult {
  /** Ordered, human-readable record of what the recovery did. */
  steps: string[];
  /** Per-operation outcomes of the drained plugin operations (if any). */
  drained: Awaited<ReturnType<typeof drainInstancePluginOperations>>['outcomes'];
  /** True when the backend booted cleanly (plugins on) at the end. */
  recovered: boolean;
  /** True when safe mode was deliberately left enabled (recovery incomplete). */
  safeModeLeftEnabled: boolean;
}

/**
 * Recover a backend that crash-loops because a plugin was only half-removed:
 * the generated bundles file still registers the plugin's bundle but its classes
 * are gone, so the Symfony kernel fatals with `Class "...Bundle" not found` on
 * EVERY request — and `bin/console` cannot boot either. This is the state left
 * when a plugin uninstall is interrupted (e.g. the manager was self-updated
 * mid-drain).
 *
 * Flow: force SAFE MODE so the kernel boots with core bundles only (the marker
 * is created directly when the console cannot boot — see {@link instanceSafeMode}),
 * restart, drain the parked uninstall (`run-operation` removes the plugin row
 * and regenerates the bundles file from the database) and reconcile with
 * `selfhelp:plugin:repair`, then leave safe mode and PROBE a real boot. If the
 * probe boots cleanly the instance is recovered; if it still fatals, safe mode
 * is re-enabled so the instance stays up (plugins disabled) and the operator is
 * told to re-trigger the uninstall from the CMS admin or restore a backup.
 */
export async function instancePluginRecover(
  deps: ActionDeps,
  instanceId: string,
  opts: { log?: (line: string) => void; keepSafeMode?: boolean; drainOverrides?: PluginDrainOverrides } = {},
): Promise<PluginRecoverResult> {
  const log = (line: string): void => opts.log?.(line);
  const paths = instancePaths(instanceId, deps.root);
  await readManifestFriendly(deps, instanceId); // fail fast if the instance is unknown
  const steps: string[] = [];
  const exec = (cmd: string[]) => deps.runner.run(paths.dir, cmd);

  log('Enabling safe mode so the backend boots without plugins…');
  await instanceSafeMode(deps, instanceId, true);
  steps.push('safe mode enabled');

  log('Restarting backend in safe mode…');
  await exec(['restart', 'backend']);
  steps.push('backend restarted in safe mode');

  log('Draining parked plugin operations (finalizes the interrupted uninstall)…');
  const report = await drainInstancePluginOperations(deps, instanceId, { log: opts.log, ...opts.drainOverrides });
  if (report.outcomes.length === 0) steps.push('no parked plugin operations to finalize');
  for (const o of report.outcomes) {
    steps.push(`plugin ${o.type} ${o.pluginId}: ${o.status}${o.detail ? ` (${o.detail})` : ''}`);
  }

  log('Reconciling the plugin bundle registration from the database (selfhelp:plugin:repair)…');
  try {
    await exec(['exec', '-T', 'backend', 'php', 'bin/console', 'selfhelp:plugin:repair']);
    steps.push('selfhelp:plugin:repair done');
  } catch (err) {
    steps.push(`selfhelp:plugin:repair failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (opts.keepSafeMode) {
    log('Leaving safe mode enabled as requested.');
    return { steps, drained: report.outcomes, recovered: false, safeModeLeftEnabled: true };
  }

  log('Disabling safe mode and probing a clean boot…');
  await instanceSafeMode(deps, instanceId, false);
  steps.push('safe mode disabled');

  // Probe a REAL (plugins-on) kernel boot: any console command triggers bundle
  // registration, so a surviving dangling bundle still fatals here.
  let recovered = false;
  try {
    await exec(['exec', '-T', 'backend', 'php', 'bin/console', 'about']);
    recovered = true;
  } catch {
    recovered = false;
  }

  if (recovered) {
    await exec(['restart', 'backend']);
    steps.push('backend booted cleanly without safe mode and was restarted');
    return { steps, drained: report.outcomes, recovered: true, safeModeLeftEnabled: false };
  }

  // Still broken (e.g. the plugin row remained because no uninstall was parked):
  // keep the instance UP in safe mode rather than crash-looping.
  log('Backend still fails to boot with plugins — re-enabling safe mode to keep the instance up.');
  await instanceSafeMode(deps, instanceId, true);
  await exec(['restart', 'backend']);
  steps.push('backend still fatals with plugins — safe mode re-enabled to keep it up');
  return { steps, drained: report.outcomes, recovered: false, safeModeLeftEnabled: true };
}
