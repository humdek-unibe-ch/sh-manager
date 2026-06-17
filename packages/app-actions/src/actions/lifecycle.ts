// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance lifecycle actions that mutate an existing instance in place:
 * change its address (domain/port), rename it, remove/disable it, re-enable it,
 * and edit its outbound mailer DSN + non-secret environment.
 */
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { formatTrustedKeysEnv } from '@shm/schemas';
import type { InstanceManifest } from '@shm/schemas';
import {
  DEFAULT_PROXY_NETWORK,
  MANAGER_CONTROLLED_ENV_KEYS,
  buildInstanceEnv,
  composeCommands,
  parseDotEnv,
} from '@shm/docker';
import { buildInstanceInstallArtifacts, evaluateHealth, type HealthReport } from '@shm/core';
import {
  InventoryStore,
  LockStore,
  ManifestStore,
  generateInstanceReadme,
  instancePaths,
  planEnable,
  planRemove,
  readInstanceSecrets,
  redactMailerDsn,
  withMailerDsn,
  writeFileAtomic,
  writeInstanceSecrets,
  type EnablePlan,
  type RemoveMode,
  type RemovePlan,
} from '@shm/instances';
import {
  assertInstallableDomain,
  ensureProxyRunning,
  readManifestFriendly,
  releaseShapesFromLock,
  restorePluginStateAfterRecreate,
  type ActionDeps,
} from './shared.js';

// ---------------------------------------------------------------------------
// instance set-address (change production domain / local port, then restart)
// ---------------------------------------------------------------------------

export interface SetAddressOptions {
  /** Production instances: the new public domain. */
  domain?: string;
  /** Local instances: the new published localhost port. */
  localPort?: number;
  /** Recreate the containers so the new address takes effect (default true). */
  restart?: boolean;
  /** Production: block (not just warn) when DNS does not resolve to this server. */
  strictDns?: boolean;
}

export interface SetAddressResult {
  changed: boolean;
  previousDomain: string;
  domain: string;
  publicUrl: string;
  warnings: string[];
  restarted: boolean;
  health?: HealthReport;
}

/**
 * Changes where an instance is reachable — the routed domain (production) or
 * the published localhost port (local) — by regenerating the instance's
 * compose/.env/manifest/README from the pinned lock versions and recreating
 * the containers. The mode itself never changes here.
 *
 * Re-applying the CURRENT address is intentionally allowed: it regenerates the
 * runtime config from the lock and restarts, which is also the documented way
 * to roll out manager-side config fixes (e.g. Mercure routing) to an existing
 * instance without an update.
 */
export async function instanceSetAddress(
  deps: ActionDeps,
  instanceId: string,
  opts: SetAddressOptions,
): Promise<SetAddressResult> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const lockStore = new LockStore(instanceId, deps.root);
  const lock = await lockStore.read();
  const mode = manifest.mode;

  if (mode === 'production' && !opts.domain) {
    throw new Error('Changing a production instance address requires --domain.');
  }
  if (mode === 'local' && opts.localPort === undefined) {
    throw new Error('Changing a local instance address requires --port.');
  }
  if (mode === 'local' && (!Number.isInteger(opts.localPort) || opts.localPort! < 1 || opts.localPort! > 65535)) {
    throw new Error('Local port must be an integer between 1 and 65535.');
  }

  // Same duplicate-domain / DNS-binding rules as an install; the instance's
  // own current claim is excluded so re-applying the same address is valid.
  const warnings = await assertInstallableDomain(deps, {
    instanceId,
    mode,
    ...(mode === 'production' ? { domain: opts.domain! } : { localPort: opts.localPort! }),
    ...(opts.strictDns !== undefined ? { strictDns: opts.strictDns } : {}),
  });

  const newDomain = mode === 'production' ? opts.domain! : `localhost:${opts.localPort}`;
  const previousDomain = manifest.domain;
  const changed = newDomain !== previousDomain;

  // Regenerate compose/.env/README/manifest with the pinned lock versions —
  // never the registry — so an address change can run fully offline and can
  // never bump code. The lock itself is NOT rewritten (versions are unchanged).
  const { core, frontend } = releaseShapesFromLock(manifest, lock, 'address-change');
  const paths = instancePaths(instanceId, deps.root);
  const artifacts = buildInstanceInstallArtifacts({
    instanceId,
    displayName: manifest.displayName,
    mode,
    ...(mode === 'production' ? { domain: opts.domain! } : { localPort: opts.localPort! }),
    root: deps.root,
    ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
    managerVersion: deps.managerVersion,
    channel: manifest.registry.channel,
    registry: { id: lock.registry.id, url: lock.registry.url, metadataSha256: lock.registry.metadataSha256 },
    core,
    frontend,
    services: lock.services,
    installedPlugins: manifest.installedPlugins,
    pluginLock: lock.plugins,
    ...(manifest.resources ? { resources: manifest.resources } : {}),
    pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
    // Keep operator env overrides across an address change.
    ...(manifest.envOverrides ? { envOverrides: manifest.envOverrides } : {}),
  });
  await writeFileAtomic(paths.composePath, artifacts.composeYaml);
  await writeFileAtomic(paths.envPath, artifacts.envText);
  await writeFileAtomic(paths.readmePath, artifacts.readme);
  await new ManifestStore(instanceId, deps.root).write({
    ...artifacts.manifest,
    createdAt: manifest.createdAt,
    updatedAt: deps.now?.() ?? new Date().toISOString(),
  });

  // Reflect the new address in the server inventory (domain is the routing key).
  const inventoryStore = new InventoryStore(deps.root);
  const inventory = await inventoryStore.read().catch(() => null);
  if (inventory) {
    const entry = inventory.instances.find((e) => e.instanceId === instanceId);
    if (entry) {
      entry.domain = newDomain;
      await inventoryStore.write(inventory);
    }
  }

  const restart = opts.restart ?? true;
  let health: HealthReport | undefined;
  if (restart) {
    // The compose declares the shared proxy network as external; make sure it
    // exists even on servers bootstrapped before multi-instance support.
    if (deps.ensureNetwork) {
      const network = inventory?.proxy.network ?? DEFAULT_PROXY_NETWORK;
      await deps.ensureNetwork(network);
    }
    // Re-applying a production address is the operator's natural "fix routing"
    // action — make sure the shared proxy is actually running, not just the
    // instance, so a server whose proxy never started becomes reachable.
    await ensureProxyRunning(deps, manifest.mode);
    await deps.runner.run(paths.dir, composeCommands.upDetached());
    // Recreated Symfony containers lose their composer-installed plugins;
    // restore them from the snapshot on the plugin volume (no-op when intact).
    await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
    health = evaluateHealth(
      instanceId,
      await deps.probeHealth(artifacts.manifest.routing.publicFrontendUrl, artifacts.manifest.routing.browserApiPrefix),
      deps.now,
    );
  }

  return {
    changed,
    previousDomain,
    domain: newDomain,
    publicUrl: artifacts.manifest.routing.publicFrontendUrl,
    warnings,
    restarted: restart,
    ...(health ? { health } : {}),
  };
}

// ---------------------------------------------------------------------------
// instance rename (change the operator-facing display name only)
// ---------------------------------------------------------------------------

export interface SetNameOptions {
  /** New operator-facing display name (the instanceId is never changed). */
  displayName: string;
}

export interface SetNameResult {
  changed: boolean;
  previousName: string;
  displayName: string;
}

/**
 * Renames an instance's operator-facing DISPLAY NAME only.
 *
 * The `instanceId` is the immutable technical key — it names the Compose
 * project, the on-disk directory, the Docker volumes/network and the routing —
 * so renaming *it* would have to recreate every Docker resource and migrate all
 * data; that is deliberately out of scope. A display-name change is metadata
 * only: it atomically rewrites the manifest (and regenerates the operator
 * README so it matches), with NO container restart and no data risk. This is
 * the rename operators want after a clone or a domain change.
 */
export async function instanceSetName(
  deps: ActionDeps,
  instanceId: string,
  opts: SetNameOptions,
): Promise<SetNameResult> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const displayName = opts.displayName.trim();
  if (displayName === '') {
    throw new Error('A display name is required (it cannot be empty).');
  }
  if (displayName.length > 200) {
    throw new Error('Display name is too long (max 200 characters).');
  }
  const previousName = manifest.displayName;
  const changed = displayName !== previousName;

  const updated: InstanceManifest = {
    ...manifest,
    displayName,
    updatedAt: deps.now?.() ?? new Date().toISOString(),
  };
  await new ManifestStore(instanceId, deps.root).write(updated);

  // Keep the generated operator README in sync (it prints the display name).
  const paths = instancePaths(instanceId, deps.root);
  await writeFileAtomic(
    paths.readmePath,
    generateInstanceReadme(updated, { managerVersion: deps.managerVersion, root: deps.root }),
  );

  return { changed, previousName, displayName };
}

// ---------------------------------------------------------------------------
// instance remove (disable / remove-keep-data / full-delete)
// ---------------------------------------------------------------------------

export interface RemoveOptions {
  mode: RemoveMode;
  deleteVolumes?: boolean;
  deleteBackups?: boolean;
  confirm?: string;
}

export async function instanceRemove(
  deps: ActionDeps,
  instanceId: string,
  opts: RemoveOptions,
): Promise<RemovePlan & { executed: boolean }> {
  const store = new InventoryStore(deps.root);
  const inventory = await store.read();
  const plan = planRemove(
    {
      instanceId,
      mode: opts.mode,
      deleteVolumes: opts.deleteVolumes,
      deleteBackups: opts.deleteBackups,
      typedConfirmation: opts.confirm,
    },
    inventory,
    deps.root,
  );
  if (!plan.ok) return { ...plan, executed: false };

  const paths = instancePaths(instanceId, deps.root);

  // 1. Compose command (stop/down — never `-v`).
  await deps.runner.run(paths.dir, plan.composeArgs);

  // 2. full_delete: remove this instance's volumes + folder.
  if (plan.deleteVolumes.length > 0) {
    if (!deps.removeVolumes) {
      throw new Error('Volume removal is not available in this manager environment.');
    }
    await deps.removeVolumes(plan.deleteVolumes);
  }
  if (plan.deleteInstanceDir) {
    if (plan.preserveBackups) {
      for (const name of await readdir(paths.dir).catch(() => [] as string[])) {
        if (path.join(paths.dir, name) === paths.backupsDir) continue;
        await rm(path.join(paths.dir, name), { recursive: true, force: true });
      }
    } else {
      await rm(paths.dir, { recursive: true, force: true });
    }
  }

  // 3. Inventory mutation.
  if (plan.removeInventoryEntry) {
    inventory.instances = inventory.instances.filter((i) => i.instanceId !== instanceId);
    await store.write(inventory);
  } else if (plan.newStatus) {
    const entry = inventory.instances.find((i) => i.instanceId === instanceId);
    if (entry) {
      entry.status = plan.newStatus;
      await store.write(inventory);
    }
  }

  return { ...plan, executed: true };
}

// ---------------------------------------------------------------------------
// instance enable (bring a disabled / removed-keep-data instance back online)
// ---------------------------------------------------------------------------

export interface EnableResult extends EnablePlan {
  executed: boolean;
  /** Post-start health probe, when the manifest was readable. */
  health?: HealthReport;
}

/**
 * Re-enables a stopped instance — the inverse of the `disable` removal mode.
 *
 * `docker compose up -d` starts the stopped containers of a `disabled` instance
 * and recreates the removed containers of a `removed_keep_data` one; either way
 * all volumes/secrets/config are still on disk, so the instance comes back with
 * its data intact. After a recreate the composer-installed plugins are remounted
 * from the plugin volume snapshot (no-op when intact). The inventory status is
 * flipped back to `active` and a best-effort health probe is returned.
 */
export async function instanceEnable(deps: ActionDeps, instanceId: string): Promise<EnableResult> {
  const store = new InventoryStore(deps.root);
  const inventory = await store.read();
  const plan = planEnable({ instanceId }, inventory);
  if (!plan.ok) return { ...plan, executed: false };

  const paths = instancePaths(instanceId, deps.root);
  const manifest = await new ManifestStore(instanceId, deps.root).read().catch(() => null);

  // The compose declares the shared proxy network as external; make sure it
  // exists (servers bootstrapped before multi-instance support, or a restarted
  // Docker daemon, may not have it yet).
  if (deps.ensureNetwork) {
    await deps.ensureNetwork(inventory.proxy.network ?? DEFAULT_PROXY_NETWORK);
  }
  // Re-enabling a production instance is pointless if the shared proxy is down;
  // bring it up too so the instance is actually reachable again.
  if (manifest) await ensureProxyRunning(deps, manifest.mode);

  // Bring the instance back: starts a stopped (disabled) stack or recreates a
  // downed (removed_keep_data) one — never `-v`, so no volume is touched.
  await deps.runner.run(paths.dir, composeCommands.upDetached());

  // A recreate drops composer-installed plugins from the Symfony containers'
  // writable layer; restore them from the plugin volume snapshot so the CMS
  // keeps its plugins (no-op when none are installed / already intact).
  if (manifest) {
    await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
  }

  // Flip inventory status back to active.
  const entry = inventory.instances.find((i) => i.instanceId === instanceId);
  if (entry) {
    entry.status = plan.newStatus;
    await store.write(inventory);
  }

  // Best-effort health probe so the operator immediately sees it came back; a
  // slow first start must never fail the (already successful) enable itself.
  let health: HealthReport | undefined;
  if (manifest) {
    try {
      health = evaluateHealth(
        instanceId,
        await deps.probeHealth(manifest.routing.publicFrontendUrl, manifest.routing.browserApiPrefix),
        deps.now,
      );
    } catch {
      health = undefined;
    }
  }

  return { ...plan, executed: true, ...(health ? { health } : {}) };
}

// ---------------------------------------------------------------------------
// instance set-mailer (operator SMTP DSN, stored in secrets.env)
// ---------------------------------------------------------------------------

export interface SetMailerOptions {
  /** SMTP DSN, e.g. `smtp://user:pass@mail.example.org:587`. */
  dsn?: string;
  /** Remove the override; the instance falls back to Mailpit/image default. */
  clear?: boolean;
  /** Recreate containers so the new DSN takes effect (default true). */
  restart?: boolean;
}

export interface MailerStatus {
  /** True when an operator DSN override is configured. */
  configured: boolean;
  /** Credential-redacted DSN for display; never the raw value. */
  redactedDsn?: string;
}

/** Reads the instance's mailer configuration (redacted, never raw). */
export async function instanceGetMailer(deps: ActionDeps, instanceId: string): Promise<MailerStatus> {
  await readManifestFriendly(deps, instanceId);
  const paths = instancePaths(instanceId, deps.root);
  const secrets = await readInstanceSecrets(paths.secretsDir);
  if (!secrets?.mailerDsn) return { configured: false };
  return { configured: true, redactedDsn: redactMailerDsn(secrets.mailerDsn) };
}

/**
 * Sets or clears the instance's outbound-mail DSN. The DSN lives in the 0600
 * `secrets.env` (it may carry SMTP credentials) and overrides the non-secret
 * Mailpit default. By default the stack is recreated so backend/worker/
 * scheduler pick the new value up immediately.
 */
export async function instanceSetMailer(
  deps: ActionDeps,
  instanceId: string,
  opts: SetMailerOptions,
): Promise<MailerStatus & { restarted: boolean }> {
  const manifest = await readManifestFriendly(deps, instanceId);
  if (!opts.clear && (!opts.dsn || opts.dsn.trim() === '')) {
    throw new Error('Provide a mailer DSN (e.g. smtp://user:pass@mail.example.org:587) or --clear.');
  }
  const dsn = opts.clear ? '' : opts.dsn!.trim();
  if (dsn !== '' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(dsn)) {
    throw new Error(`"${dsn}" is not a valid mailer DSN (expected scheme://…, e.g. smtp://host:587).`);
  }

  const paths = instancePaths(instanceId, deps.root);
  const existing = await readInstanceSecrets(paths.secretsDir);
  if (!existing) {
    throw new Error(`Instance "${instanceId}" has no secrets directory; was it installed by this manager?`);
  }
  const updated = withMailerDsn(existing, dsn);
  await writeInstanceSecrets(paths.secretsDir, updated, deps.secretIO);

  const restart = opts.restart ?? true;
  if (restart) {
    // `up -d` recreates only the services whose env_file content changed.
    await deps.runner.run(paths.dir, composeCommands.upDetached());
    // Recreated Symfony containers lose their composer-installed plugins;
    // restore them from the snapshot on the plugin volume (no-op when intact).
    await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
  }
  return {
    configured: dsn !== '',
    ...(dsn !== '' ? { redactedDsn: redactMailerDsn(dsn) } : {}),
    restarted: restart,
  };
}

// ---------------------------------------------------------------------------
// instance environment editor (non-secret .env)
// ---------------------------------------------------------------------------

export interface InstanceEnvEntry {
  key: string;
  /** Effective value currently in the live `.env`. */
  value: string;
  /**
   * Manager-generated default for this key (before overrides). Absent for
   * operator-added custom keys. Lets the editor show "modified vs default" and
   * offer a one-click reset.
   */
  defaultValue?: string;
  /** Manager-owned structural key (read-only; see MANAGER_CONTROLLED_ENV_KEYS). */
  managed: boolean;
  /** Operator added this key (not part of the generated base env). */
  custom: boolean;
  /** An operator override is currently in effect for this key. */
  overridden: boolean;
}

export interface InstanceEnvConfig {
  instanceId: string;
  /** Effective `.env` entries (the live non-secret runtime config). */
  entries: InstanceEnvEntry[];
  /** Keys the editor must render read-only. */
  managedKeys: string[];
}

export interface SetEnvOptions {
  /**
   * Full set of operator overrides to persist (replaces the previous set).
   * Structural keys are rejected; secrets must never be sent here.
   */
  overrides: Record<string, string>;
  /** Recreate containers so the new values take effect (default true). */
  restart?: boolean;
}

export interface SetEnvResult {
  applied: number;
  restarted: boolean;
  health?: HealthReport;
}

/** Builds the env input that mirrors what install/update generate for this instance. */
function envInputFromManifest(deps: ActionDeps, manifest: InstanceManifest) {
  return {
    instanceId: manifest.instanceId,
    mode: manifest.mode,
    selfhelpVersion: manifest.versions.selfhelp,
    frontendVersion: manifest.versions.frontend,
    publicFrontendUrl: manifest.routing.publicFrontendUrl,
    registryUrl: manifest.registry.url,
    pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
  };
}

/**
 * Reads an instance's non-secret environment. The values come from the live
 * `.env` (secrets live in `secrets.env`, which is NEVER read here), classified
 * so the UI can render manager-owned keys read-only and operator-set keys as
 * editable.
 */
export async function instanceGetEnv(deps: ActionDeps, instanceId: string): Promise<InstanceEnvConfig> {
  const manifest = await readManifestFriendly(deps, instanceId);
  const paths = instancePaths(instanceId, deps.root);
  const fileEnv = parseDotEnv(await readFile(paths.envPath, 'utf8').catch(() => ''));
  // Generated baseline (no overrides): tells us each key's default + which keys
  // are operator-added "custom" ones.
  const baseEnv = buildInstanceEnv(envInputFromManifest(deps, manifest));
  const overrides = manifest.envOverrides ?? {};

  const entries: InstanceEnvEntry[] = Object.entries(fileEnv)
    .map(([key, value]) => {
      const defaultValue = baseEnv[key];
      return {
        key,
        value,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        managed: MANAGER_CONTROLLED_ENV_KEYS.includes(key),
        custom: defaultValue === undefined,
        overridden: Object.prototype.hasOwnProperty.call(overrides, key),
      };
    })
    .sort((a, b) => {
      // Editable first, managed last; alphabetical within each group.
      if (a.managed !== b.managed) return a.managed ? 1 : -1;
      return a.key.localeCompare(b.key);
    });

  return { instanceId, entries, managedKeys: [...MANAGER_CONTROLLED_ENV_KEYS] };
}

/**
 * Persists operator env overrides and regenerates the instance `.env`. The
 * overrides live on the manifest so they survive every later regeneration
 * (update/clone/address-change). Structural keys are refused, and the stack is
 * recreated by default so all services pick up the change.
 */
export async function instanceSetEnv(deps: ActionDeps, instanceId: string, opts: SetEnvOptions): Promise<SetEnvResult> {
  const manifest = await readManifestFriendly(deps, instanceId);

  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(opts.overrides ?? {})) {
    const key = rawKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`"${rawKey}" is not a valid environment variable name (use letters, digits, and underscores; cannot start with a digit).`);
    }
    if (MANAGER_CONTROLLED_ENV_KEYS.includes(key)) {
      throw new Error(`${key} is managed by the manager and cannot be edited here${key === 'MAILER_DSN' ? ' — use the outbound-email settings instead' : ''}.`);
    }
    const value = String(rawValue);
    if (/[\r\n]/.test(value)) {
      throw new Error(`The value for ${key} must be a single line (no newlines).`);
    }
    sanitized[key] = value;
  }

  const lockStore = new LockStore(instanceId, deps.root);
  const lock = await lockStore.read();
  const { core, frontend } = releaseShapesFromLock(manifest, lock, 'env-change');
  const paths = instancePaths(instanceId, deps.root);
  const localPort =
    manifest.mode === 'local' ? Number(new URL(manifest.routing.publicFrontendUrl).port) : undefined;

  const artifacts = buildInstanceInstallArtifacts({
    instanceId,
    displayName: manifest.displayName,
    mode: manifest.mode,
    ...(manifest.mode === 'production' ? { domain: manifest.domain } : { localPort: localPort! }),
    root: deps.root,
    ...(deps.engineRoot ? { engineRoot: deps.engineRoot } : {}),
    managerVersion: deps.managerVersion,
    channel: manifest.registry.channel,
    registry: { id: lock.registry.id, url: lock.registry.url, metadataSha256: lock.registry.metadataSha256 },
    core,
    frontend,
    services: lock.services,
    installedPlugins: manifest.installedPlugins,
    pluginLock: lock.plugins,
    ...(manifest.resources ? { resources: manifest.resources } : {}),
    pluginTrustedKeys: formatTrustedKeysEnv(deps.trustedKeys),
    envOverrides: sanitized,
  });

  // Only the .env content depends on the overrides; the compose/readme are
  // unchanged, so we write just the .env and the manifest (which now records
  // the overrides). Atomic writes never corrupt the running instance.
  await writeFileAtomic(paths.envPath, artifacts.envText);
  await new ManifestStore(instanceId, deps.root).write({
    ...artifacts.manifest,
    createdAt: manifest.createdAt,
    updatedAt: deps.now?.() ?? new Date().toISOString(),
  });

  const restart = opts.restart ?? true;
  let health: HealthReport | undefined;
  if (restart) {
    await deps.runner.run(paths.dir, composeCommands.upDetached());
    // Recreated Symfony containers lose their composer-installed plugins;
    // restore them from the snapshot on the plugin volume (no-op when intact).
    await restorePluginStateAfterRecreate(deps, instanceId, manifest.versions.selfhelp);
    health = evaluateHealth(
      instanceId,
      await deps.probeHealth(manifest.routing.publicFrontendUrl, manifest.routing.browserApiPrefix),
      deps.now,
    );
  }

  return {
    applied: Object.keys(sanitized).length,
    restarted: restart,
    ...(health ? { health } : {}),
  };
}
