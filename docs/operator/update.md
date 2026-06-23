# Update an instance

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`)
Last verified: 2026-06-23
Source of truth: `apps/cli/src/bin.ts`, `apps/cli/src/actions.ts`, `packages/core/src/update.ts`, `packages/resolver/src/core.ts`, `packages/app-actions/src/actions/update.ts`

Updates are **backup-first** and **rollback-on-failure**. The manager resolves a
compatible target version (honouring security advisories and core ⇄ frontend ⇄
plugin compatibility), runs a preflight, and only then applies the change.

## 1. Preview the update (dry run)

Always start with a dry run. It shows the resolved plan and the preflight; it
changes nothing.

```bash
sh-manager instance update website1 --dry-run
```

Optionally target a specific channel/version:

```bash
sh-manager instance update website1 --dry-run --channel stable --version latest
```

Read the preflight output:

- **ok** — safe to apply.
- **warning** — apply with care; read the reasons.
- **blocked** — do not apply; the reasons explain what to fix first (for example
  an incompatible plugin or an open advisory).

## 2. Apply the update

```bash
sh-manager instance update website1
```

The execution is reported step by step. The manager:

1. Takes a fresh **backup** first.
2. Pulls the signed target images and re-pins digests in `lock.json`.
3. Runs migrations.
4. Health-checks.
5. On any failure, **rolls back** to the pre-update state and reports
   `ROLLED BACK`.

### Destructive migrations

If the target carries a migration flagged as destructive, the update is blocked
until you explicitly accept the risk:

```bash
sh-manager instance update website1 --accept-migration-risk
```

Take a manual backup and read the release notes before using this flag.

## 3. Verify

```bash
sh-manager instance health website1
```

## Frontend-only updates

The frontend is released on its own cadence in the registry. An instance that is
already on the newest **core** can still have a newer compatible **frontend**
(for example core `0.1.4` with frontend `0.1.5`, while the registry already ships
frontend `0.1.7` for that core). A normal `instance update` reports the core as
up to date and, when so, automatically offers the frontend-only update; you can
also run it explicitly.

This is the **lightweight** path. The frontend is stateless, so the manager:

- pulls **only** the frontend image and recreates **only** the frontend
  container (`--no-deps`),
- takes a config snapshot (not a full database backup),
- runs **no** database migration and needs **no** maintenance window,
- leaves the core stack and every volume untouched,
- health-checks and **rolls back** the frontend on failure.

```bash
# Preview (pure read): resolves the newest compatible frontend.
sh-manager instance update-frontend website1 --dry-run

# Apply (optionally pin a version / pick a channel):
sh-manager instance update-frontend website1
sh-manager instance update-frontend website1 --version 0.1.7
sh-manager instance update-frontend website1 --channel beta
```

The resolver refuses a downgrade or any frontend whose `requiredCoreRange` does
not include the instance's current core, and honours security advisories. In the
GUI, use **Update frontend…** on the instance detail page (dry-run first, then
execute). A frontend-only update can also be requested from the CMS (it records a
`kind: frontend` operation the manager drains — see below).

## Mobile-preview updates

The **mobile preview** (`selfhelp-mobile-preview`) is an optional, independently
versioned service that lets a CMS admin preview a page as it renders in the Expo
mobile app, embedded in the page editor. It is released on its own cadence in the
registry (release kind `selfhelp-mobile-preview-release`, listed under
`registry.json#mobilePreview[]`) and updated with the same **lightweight** path
as the frontend — it is stateless, so the manager:

- pulls **only** the mobile-preview image and recreates **only** that container
  (`--no-deps`),
- takes a config snapshot (not a full database backup),
- runs **no** database migration and needs **no** maintenance window,
- leaves the core stack, the frontend, and every volume untouched,
- health-checks (`/healthz`) and **rolls back** on failure.

```bash
# Preview (pure read): resolves the newest compatible mobile-preview image.
sh-manager instance update-mobile-preview website1 --dry-run

# Apply (optionally pin a version / pick a channel):
sh-manager instance update-mobile-preview website1
sh-manager instance update-mobile-preview website1 --version 0.2.1
sh-manager instance update-mobile-preview website1 --channel beta
```

The resolver picks a mobile-preview image whose `release-manifest.json`
`supports.core` includes the instance's current core (same `pickServiceForCore`
logic as the scheduler/worker services), refuses a downgrade, and honours
security advisories. The backend stays **private**: the manager wires the
preview's in-container proxy to the backend over the internal Docker network and
adds a Traefik `Host(...) && PathPrefix(/mobile-preview)` route for the browser
iframe — no extra public backend port is opened.

### Plugin mobile-compatibility gate

The dry run also runs a **dual-axis plugin gate** for every plugin installed on
the instance, comparing each plugin's manifest against the candidate image:

- **blocked** — a plugin's `compatibility.mobile` range excludes the image's
  advertised `mobileRendererVersion` (or its `reactNative` / `expoSdk` runtime
  axis is incompatible). The update is **refused** until you pick a compatible
  image or update the plugin.
- **warning** — the plugin is compatible but **not bundled** in the image, or its
  declared range drifts from the bundle. The plugin still works via the preview's
  **open-on-web** fallback (a deep-link to the web frontend); native rendering is
  unavailable for it.
- **info** — a web-only plugin that declares no `compatibility.mobile` axis; it is
  irrelevant to the mobile preview.

In the GUI, use **Update mobile preview…** on the instance detail page; the
dialog lists each plugin's evaluation and disables **Execute** while any plugin is
`blocked`. A mobile-preview update can also be requested from the CMS (it records
a `kind: mobile-preview` operation the manager drains — see below).

## CMS-requested updates (instance-scoped)

The CMS never controls Docker. When an instance requests an update from its admin
UI, it records an **instance-scoped** operation; the manager claims and executes
it. The wiring is automatic:

- The per-instance `SELFHELP_MANAGER_TOKEN` is **generated at install** and
  injected into the instance's backend via its secrets env. Existing instances
  get it backfilled by the next `sh-manager instance update` or
  `sh-manager instance repair <id>`.
- The default transport **execs into the backend container** (no published
  port, no URL to configure); the container's own token authenticates the call.
- While the **persistent web UI** is running, a background poller drains
  pending operations for all instances (default every 15 s,
  `SHM_CMS_POLL_SECONDS` overrides; see
  [GUI instance management](gui-instance-management.md)). Each run is
  journaled and visible in the GUI operation history.

To drain manually, or on a headless schedule (one run drains every pending
operation for that instance, then exits):

```bash
sh-manager instance process-operations website1

# resident, supervised loop:
sh-manager instance process-operations website1 --watch --interval 15

# advanced: a remote/HTTP backend instead of the exec transport
sh-manager instance process-operations website1 \
  --backend-url http://127.0.0.1:PORT --token "$SELFHELP_MANAGER_TOKEN"
```

- The backend never trusts a browser-provided `instanceId`; cross-instance
  attempts are denied and logged.
- For headless servers without the resident GUI, wire a supervised trigger per
  instance — see [`deploy/`](../../deploy/README.md) for the ready-made systemd
  template unit (`--watch`) and cron example, and
  [operations-runbook](operations-runbook.md) ("Scheduling the update-operations
  loop").
- The CMS System page shows the **manager loop** health component ("last seen")
  and warns when a request sits on `requested` too long — that means no drain
  loop is running; start the persistent UI or the systemd unit.

## If an update fails

- A failed update **rolls back** automatically; the instance keeps running on the
  previous version. Re-run the dry run to see why.
- If the instance is unhealthy after a manual change, see
  [safe mode & recovery](safe-mode-and-recovery.md) and
  [backup & restore](backup-restore.md).
