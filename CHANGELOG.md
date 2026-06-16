# Changelog

All notable changes to **SelfHelp Manager** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

The manager has two version axes (see
[docs/release-publishing.md](docs/release-publishing.md)):

- **The manager tool** uses its own semver (currently `1.5.7`). Registry releases
  declare a `requiresManager` constraint, so the tool version is a compatibility
  contract.
- **The SelfHelp platform** it installs/updates is currently the pre-release
  **`0.x`** line (core, frontend, scheduler, worker — all `0.1.0`).

A single manager `0.1.0` installs and manages SelfHelp `0.x` pre-release instances.

## [1.5.7] - 2026-06-16

### Fixed
- **Admin/plugin actions failed with "CSRF validation failed" on production
  domains (e.g. SurveyJS "Create survey"), while the same action worked on a
  local Docker instance.** The generated `CORS_ALLOW_ORIGIN` allowed **only
  localhost**, but the backend validates the browser `Origin` of state-changing
  requests and the frontend BFF forwards the *real* origin — `http://localhost:<port>`
  locally (allowed) versus `https://<domain>` in production (rejected). Production
  instances now also allow their own public `https://<domain>` origin (local mode
  keeps the strict localhost-only regex, since its origin already is localhost).
  Apply to an existing instance by regenerating its `.env` — re-apply the address
  (`instance set-address <id> --domain <same-domain>`), change an env var, or run
  an update; `CORS_ALLOW_ORIGIN` stays operator-overridable. New env tests.
- **"Could not read logs for mailpit … no such service: mailpit" confused
  operators trying to send real mail.** The log picker offered **Mailpit** for
  every instance, but Mailpit is the bundled local **test mailbox** that only
  exists in local-mode compose (it catches mail and never relays it). The picker
  now shows Mailpit **only for local-mode instances**, and a `no such service`
  log read returns a clear, actionable message instead of the raw compose error —
  for Mailpit it points operators at the real fix: set an SMTP relay DSN (e.g.
  `smtp://smtp.unibe.ch:25` for a passwordless campus relay) via **Outbound
  email** / `instance set-mailer`. New CLI + dialog tests.

### Added
- **`sh-manager doctor` now flags the Redis "Memory overcommit must be enabled"
  warning.** When the host kernel has `vm.overcommit_memory=0` (the common distro
  default that makes Redis warn on every start), doctor raises a
  `resources.overcommit` advisory with the exact host fix
  (`sudo sysctl vm.overcommit_memory=1`, persisted under `/etc/sysctl.d/`). It is
  a host sysctl — the container/image cannot change it at runtime — and is a
  warning, not a failure. New preflight tests cover the advisory and that it stays
  silent when the value is `1` or unreadable (non-Linux hosts).

### Changed
- **Clearer guidance for "I updated but still see the old GUI".** `self-update`
  now reminds you to **reload the browser** after the GUI container is recreated,
  and states that you **do not need to stop the SSH tunnel** (it keeps forwarding
  to the recreated container's published port). The operations dashboard's manager
  card and the troubleshooting / reverse-proxy runbooks document the same: reload
  (hard refresh), the tunnel is fine, and the GUI container only recreates when
  `self-update` runs in a *separate* container (a run inside `sh-manager-web`
  cannot restart itself).

### Documentation
- Troubleshooting gains **"Sending email / Mailpit vs a real SMTP relay"**,
  **"Redis logs 'Memory overcommit must be enabled'"**, **"Admin/plugin action
  fails with 'CSRF validation failed' only on the live domain"**, and
  **"Frontend logs `getaddrinfo ENOTFOUND backend`"** (the backend is
  down/restarting, not a frontend bug) sections. The old-GUI guidance now adds the
  **`reinstall`** escalation for a stale container/image and clarifies that the
  dashboard Manager-card version reflects the *running* build. The reverse-proxy
  runbook's old-GUI section covers the SSH tunnel and the self-restart caveat.

## [1.5.5] - 2026-06-16

### Fixed
- **Every instance domain answered `404 page not found` over HTTPS even though the
  containers were healthy and correctly labelled.** Root cause: Docker Engine 29
  raised the daemon's *minimum* API version to 1.44, and the pinned Traefik
  (`v3.1`) hardcoded Docker API `1.24` in its Docker provider. On Engine 29+ that
  provider failed every poll (`client version 1.24 is too old. Minimum supported
  API version is 1.44`) and discovered **no containers** — so Traefik had zero
  routers and returned a 404 for every request, with no certificate ever issued.
  The shared proxy now pins **`traefik:v3.7.5`**, which auto-negotiates the Docker
  API version (added in Traefik 3.6.1). Note: setting `DOCKER_API_VERSION` does
  **not** help — Traefik ignores it; the image floor is the fix. A regression test
  guards the pin at `>= v3.6.1`. After updating the manager, run
  `sh-manager server start` once to recreate the proxy on the new image.

### Added
- **Reverse-proxy (Traefik) logs are now visible from the manager — CLI and
  GUI — so diagnosing a 404 / missing-certificate no longer needs SSH and
  remembering compose paths.** New `sh-manager server logs` command (with
  `--tail`) and a **"Reverse proxy (TLS & routing)"** card on the operations
  dashboard with a **View proxy logs** dialog (tail + filter, plus quick filters
  for TLS/`acme`, errors, and routing). Logs are read via `docker compose logs`
  and **redacted** before they reach the terminal or browser, mirroring the
  existing per-instance logs. The card also surfaces the `server start` repair
  command. Covered by new BFF, fake-client, and dialog tests.

## [1.5.4] - 2026-06-16

### Fixed
- **GUI kept showing the previous manager version after an update, even across a
  hard refresh.** The BFF served `/api/*` responses with no cache directive, so a
  browser could cache `/api/state` (which carries `managerVersion`). API
  responses are now sent with `Cache-Control: no-store` (the SPA shell already
  used `no-cache`). New web test asserts `/api/state` is `no-store`.

### Changed
- **`README.md` rewritten to match the actual CLI surface.** The biggest source
  of confusion: `up` / `down` / `update` / `reinstall` / `web` are verbs of the
  generated **wrapper script** (`shm.sh` / `shm.ps1`), not `sh-manager` CLI
  subcommands — and a bare `docker run … sh-manager` alias also never publishes
  the GUI port, so `shm web` through it is unreachable (the "I see the old GUI /
  can't reach it" report). The Linux quickstart now generates and uses the
  wrapper (consistent with Windows), the lifecycle section states these are
  wrapper-only verbs, and a **complete command reference** documents every
  `server` / `instance` / `admin` command from the code — including the
  instance "up/down" (`instance enable` / `instance remove --mode disable`) and
  `server start`. Examples use `shm`.

## [1.5.3] - 2026-06-16

### Fixed
- **A production instance is no longer left installed-but-unreachable when the
  server's first bootstrap could not start the shared proxy.** The Traefik proxy
  (the single entry point that terminates TLS and routes every instance) was only
  ever started by the **first** `server init`. If that bring-up failed — the
  pre-1.5.1 proxy-network label bug, or an existing **Apache/nginx** holding
  80/443 at the time — the inventory was already written, so every later
  install/reinstall **skipped** init and the proxy stayed down: the instance
  installed and provisioned fine but was unreachable and health reported
  `unhealthy` (`backend fetch failed` / `frontend unreachable`), with no command
  to bring just the proxy back. The manager now **idempotently (re)starts the
  shared proxy on every production bring-up** — `instance install` (so a reinstall
  self-heals), `instance set-address` (so re-applying the domain fixes routing),
  and `instance enable` — and never starts it in local mode (which must not grab
  80/443 on a dev host). Covered by new install/enable/repair proxy tests.

### Added
- **New `sh-manager server start` command (CLI) to (re)start the shared Traefik
  proxy.** An explicit repair for a server whose proxy is down (failed first
  init, a host that came up before Docker, a manually stopped proxy): it brings
  the proxy up when the server hosts a production instance and is a clear no-op
  on a local-only server. Pairs with the automatic self-heal above for operators
  who prefer an explicit step.

### Changed
- **`docs/operator/reverse-proxy-and-apache.md` now documents the proxy
  self-heal and the `server start` repair**, and clarifies that on a Docker-only
  install the command is the `shm` alias/wrapper (the in-image binary is
  `sh-manager`).

## [1.5.2] - 2026-06-16

### Fixed
- **A manager self-update is now picked up on the next page load instead of
  still showing the old GUI.** The web console served its single-page-app shell
  (`index.html`) with no `Cache-Control` header, so browsers cached it and kept
  loading the previously-hashed JS bundle after `sh-manager self-update` — the
  operator updated to a new version but the console header still showed the old
  one until a manual hard refresh. The BFF now serves the app shell as
  `Cache-Control: no-cache` (always revalidated) while content-hashed assets
  under `assets/` are served `immutable`, so a new version loads automatically.
  Covered by a new server test asserting the shell-vs-asset cache headers. (If
  you are coming from an older manager, do one hard refresh to drop the
  already-cached shell.)

### Changed
- **The "ports 80/443 already in use" preflight error is now actionable.** It
  named only the busy port; on a real server the cause is almost always an
  existing **Apache or nginx** holding 80/443, which the bundled Traefik proxy
  must own (it terminates TLS and routes every instance). The message now
  explains that the SelfHelp proxy must own those ports and gives the fix
  (`sudo systemctl disable --now apache2`) and how to find the holder
  (`sudo ss -ltnp 'sport = :80'`). Covered by an updated preflight test.

### Added
- **New operator guide:
  [`docs/operator/reverse-proxy-and-apache.md`](docs/operator/reverse-proxy-and-apache.md).**
  Answers "do we need Apache?" (no — Traefik is the web server/reverse proxy and
  must own 80/443), how to free the ports from an existing Apache/nginx on
  Ubuntu, the supported options when another web server must stay on the host,
  and the DNS + Let's Encrypt checklists for the "domain does not load / no SSL"
  symptom. Cross-linked from the docs index, install, domains-and-ports, and
  troubleshooting runbooks (with a new troubleshooting entry for "updated the
  manager but still see the old GUI").

## [1.5.1] - 2026-06-16

### Fixed
- **Production server init no longer fails at "server init" with a Traefik proxy
  network label error.** Bootstrapping a server with a domain (production mode)
  creates the shared `selfhelp_proxy` network with `docker network create` and
  then runs `docker compose up -d` for the Traefik proxy. The proxy compose
  declared that network as a *managed* (non-external) network, so Compose tried
  to take ownership of the network it had not created and aborted the very first
  bring-up with:

  > network selfhelp_proxy was found but has incorrect label
  > `com.docker.compose.network` set to "" (expected: "selfhelp_proxy")

  The proxy compose now declares `selfhelp_proxy` as `external: true`, exactly
  like every instance compose already does. The network is manager-owned
  (created idempotently during server init so it also exists in local mode where
  no proxy container runs) and merely *attached to* by the proxy and instances.
  Existing servers left in this broken state are repaired automatically on the
  next attempt — re-run the install/bootstrap with this version (after
  `docker pull` of the new manager image); no manual `docker network rm` is
  required. Covered by a new proxy-compose regression test asserting the network
  is declared external in both production and local mode.

### Added
- **Instances now have a dedicated Disable / Enable toggle — you can bring a
  disabled instance back.** Previously the only way to stop an instance was the
  hidden *Disable* option inside the **Remove…** dialog, and once disabled there
  was no way to start it again from the manager (you had to drop to the CLI /
  Docker). Disabling is now a first-class, reversible lifecycle action with a
  matching way back:
  - The instance detail header shows **Disable…** when the instance is running
    (`active`) and **Enable** when it is stopped (`disabled` or
    `removed_keep_data`). Enable runs `docker compose up -d` — starting the
    stopped containers of a disabled instance or recreating the kept-data ones —
    remounts composer-installed plugins, runs a health probe, and flips the
    inventory status back to `active`. All volumes, secrets, uploads, plugins and
    backups are preserved, so the instance comes back exactly as it was.
  - The **Remove…** dialog no longer carries the *Disable* option; it is now only
    about removal (remove-containers-keep-data and full delete).
  - Disable/enable are journaled under their own operation kinds
    (`instance_disable` / `instance_enable`) instead of the generic
    `instance_remove`, so the operation history reads "instance disable" /
    "instance enable" with a live step checklist.
  - New BFF routes `POST /api/instances/:id/disable` and `.../enable`, a new
    `planEnable` pure planner in `@shm/instances` (refuses already-active /
    transient / unknown instances), an `instanceEnable` action, and a parity
    `sh-manager instance enable <id>` CLI command. Covered by planner, server
    route, operation-step and web UI toggle tests.

## [1.4.9] - 2026-06-16

### Changed
- **A CMS-requested core/frontend update now appears as a *core update* in the
  operation history, with its real live step checklist.** When an operator
  requested an update from the SelfHelp CMS, the background poller drained it
  inside a single `cms_operations_drain` operation, so the manager's operation
  history labelled a core update as the opaque **"Plugin / CMS operation"** and
  showed only one "Process pending CMS & plugin operations" row — the actual
  resolve → backup → pull → recreate → migrate → health steps never lit up while
  it ran. The poller now peeks what is pending (`peekPendingCmsWork`) and
  journals a core update as `instance_update` ("instance core update") and a
  frontend update as `instance_frontend_update`, keeping `cms_operations_drain`
  only for plugin-only drains. The drain mirrors the update's live lifecycle
  phases into the operation journal (`@shm/core` gained an optional `onPhase`
  write-back mirror), so the checklist advances in real time just like a direct
  `instance update`. Covered by new poller + phase-mapping + label tests.

### Changed
- **Update, clone, restore and backup now show their steps live, one by one.**
  Previously the operation step checklist sat on the first row until the whole
  operation finished and then ticked every row green at once ("I was on the
  first one… then waited a lot and then it fully finished all"). The core
  update/rollback, the clone, the restore and the backup now report each phase
  to the operation journal **as it starts**, so the checklist advances in real
  time and the live log streams the matching detail:
  - **Update** threads a new `onStep` callback from `@shm/core`
    (`executeUpdate` / `executeFrontendUpdate`) through the CLI action into the
    BFF, which maps each step to a journal phase (plan → backup → pull →
    recreate → migrations → health).
  - **Clone** reports `plan → secrets → volumes → database → recreate → health`
    via an `onPhase` callback (the clone step checklist was expanded to match).
  - **Backup** reports `database → metadata → volumes → manifest`; **restore**
    reports `pre-restore backup → verify → stop → volumes → database → config →
    recreate → migrate → health`.
- **Plugin / CMS operations are self-describing.** A drained CMS-requested
  operation used to appear only as the opaque kind `cms operations drain`, so an
  operator who installed/updated a plugin in the admin UI "had no idea this was
  a plugin installation". The journaled operation now sets a human phase
  (e.g. *Installing plugin sh2-shp-survey-js 0.2.22*) and logs the requested
  plugin work before any composer step runs, and the manager displays the kind
  as **"Plugin / CMS operation"** instead of the internal name.

### Added
- **Installed plugins are read live from the running instance.** The instance
  workspace's **Installed plugins** card now queries the instance's own
  `plugins` table (the durable source of truth) instead of only the manifest's
  recorded list — which lags CMS-driven installs and showed *"No plugins
  installed"* even when plugins were installed (e.g. on `localhost:9111`). Each
  plugin shows its version and an **Enabled/Disabled** status; when the instance
  is unreachable the card transparently falls back to the manifest list. Served
  by a new `GET /api/instances/:id/plugins` endpoint and a dedicated react-query
  key so the chatty SSE log stream doesn't re-run the heavier live read.
- **"Latest version" column with update-available badges.** The Components &
  versions card now has a **Latest version** column for SelfHelp/backend,
  frontend, scheduler and worker (resolved from the registry dry-run), with an
  **Update available** badge so an operator can see at a glance that an update
  is possible — and it lists **every** container image, including Mailpit (local
  instances), MySQL, Redis and Mercure, for a consistent picture.
- **Click an operation to see its full detail.** Operation-history rows are now
  clickable and open a modal with the operation's step checklist, the full
  (redacted) journaled log and its result payload — previously clicking a row
  did nothing.
- **Log tools: "errors only" filter + copy to clipboard.** The live operation
  log can be filtered to just the problem lines (errors/failures/warnings) and
  copied to the clipboard in one click (the copy always grabs the full redacted
  log, regardless of the on-screen filter).
- **Pagination on the Installed plugins table** too, alongside the existing
  paginated operation-history, backups and instance tables.

### Fixed
- **Cloning sets the clone's own display name.** A clone now records the target
  instance's name as its display name instead of inheriting the source's, and an
  optional **Display name** field in the clone dialog lets you set it up front.
- **A parked plugin `purge` is handled like an uninstall.** If the backend parks
  a managed-mode `purge` operation for the operator, the manager now runs the
  composer **remove** path (never an accidental install) and labels it as a
  purge, instead of mis-mapping the unknown type to "install".

### Notes (require the SelfHelp backend/frontend, not the manager)
These reported issues live in the platform repositories and are tracked
separately; the manager cannot fix them on its own:
- The maintenance **system message** does not refresh after editing (cache is
  not cleared on change) and its HTML renders as literal `<p>` tags — backend
  cache invalidation + frontend HTML rendering.
- The maintenance alert **`{{system.maintenance_message}}` interpolation** and
  the default maintenance page seed belong in the backend version DB migration.
- **Uninstalling a plugin signs the operator out** (the session is dropped) —
  backend/frontend session handling, not a manager action.
- Plugin **purge** only produces a visible manager operation if the backend
  **parks** it for the operator the way install/uninstall are parked; the
  manager side is now ready to drain + label it once it is.

## [1.4.7] - 2026-06-16

### Changed
- **The console is event-driven — background polling is gone.** Every manager
  view (instance list, instance workspace, operation history, the live
  operation log, backups) used to refresh on a fixed `refetchInterval` timer,
  so an idle console kept hammering the BFF. The views are now driven by the
  `GET /api/events` Server-Sent-Events stream from `1.4.6`: they refresh the
  instant the backend journals a change and otherwise make **no repeating
  requests**. A short **fallback poll** activates **only** while the stream is
  disconnected (and, for per-operation views, only while an operation is still
  `running`) and stops the moment the stream reconnects. On reconnect the
  console invalidates the manager-scoped queries once to reconcile anything
  missed while the stream was down — so you no longer need a manual full-page
  refresh to see current state after a blip. (New shared connection store
  `manager-sse-status.ts`; `manager-events.ts` now reports stream `open`.)

### Added
- **Components & versions and Installed plugins, per instance.** The instance
  workspace now shows a **Components & versions** card (the resolved
  core / frontend / scheduler / worker versions and the exact container images
  this instance runs, read from its manifest) and an **Installed plugins** card
  (each plugin with its installed version), so an operator can confirm what a
  given instance is actually running without SSHing in.
- **Step tracking for every operation.** Opening an operation in the history now
  shows a **step checklist** for its kind — update, frontend update, backup,
  restore, clone, address / email / env change, restart, remove — that advances
  with the real journaled phase (the same treatment the install wizard already
  had), with the journaled log streaming underneath. Driven by a new
  `operation-steps.ts` map; the install wizard keeps rendering its own checklist
  (the embedded log opts out via a `showSteps` prop) so steps are never doubled.
- **Pagination for long tables.** The operation history, the backups list and
  the instance list now paginate once they grow past a page, via a shared
  `usePagination` hook + `PaginationFooter`, so a busy server stays navigable.

### Fixed
- **Status pills are no longer clipped.** Instance status, "operation running",
  operation status, backup origin and per-service health pills in the manager
  tables now render their **full label** instead of truncating — they use the
  non-truncating `StatusBadge` with consistent tones.

## [1.4.6] - 2026-06-15

### Added
- **Live operations console (Server-Sent Events).** The web console now opens a
  single authenticated event stream (`GET /api/events`) and refreshes the
  operation history, the live operation log, the instance detail and the
  left-hand instance list **the instant** the backend changes — installs,
  updates, backups, restores, clones, and address/email/env/name changes all
  update in real time instead of waiting for the next poll. The operation
  journal is the single source of truth: it emits a compact change event on
  every create/advance/finish, the BFF streams it (with a heartbeat and prompt
  teardown on shutdown), and the browser turns each event into a targeted query
  refresh (bursts of log lines are coalesced). Polling stays on as a fallback,
  so a browser without `EventSource` or a dropped stream still stays correct —
  it just loses the instant feel. No secrets cross the wire: events carry only
  id/kind/instance/status/phase/timestamps, never logs or results.

### Fixed
- **Logs viewer: one scrollbar and a sticky filter.** The per-instance **Logs…**
  dialog scrolled twice (the modal body *and* an inner log box) and the
  service/line controls scrolled out of view while reading a long log. The
  controls — plus a new **Filter** field that case-insensitively substring-matches
  log lines — now stay pinned at the top, and the log output owns the single
  scroll region. You can scroll a long log and still narrow it down (e.g. to
  `ERROR`) without losing the controls. (Dialogs gained an opt-in
  `scrollBody={false}` so a dialog can pin a header and scroll just a sub-region
  instead of nesting two scrollbars.)

## [1.4.5] - 2026-06-15

### Added
- **Per-instance log viewer.** A new **Logs…** button on the instance detail
  page (and CLI `instance logs <id> [--service <svc>] [--tail <n>]` +
  `GET /api/instances/:id/logs`) reads a service's recent container logs
  (backend, frontend, worker, scheduler, mysql, redis, mercure, mailpit) with
  **secrets redacted** — diagnose an instance from the manager without SSHing in.
  It is read-only, so it stays available while an operation runs. These are the
  running container's logs (reset when the container is recreated by an update);
  a support bundle still captures a portable point-in-time copy.

### Fixed
- **Clone now copies the admin "sector".** A clone copied the source database
  (so the admin user + password hash came along) but not the source's
  `admin_password` secret file, leaving the operator unable to retrieve the
  (valid) cloned admin login via `instance admin-password`. The clone now carries
  that 0600 file across (no-op when the source used an operator-supplied password
  that was never persisted).
- **Left instance list refreshes after rename and other actions.** The instance
  detail view now also invalidates the instances list query when an operation
  starts/finishes, so a rename/update/address change is visible in the left
  sidebar immediately instead of after a full page reload.
- **Frontend-only updates report the new version.** A frontend-only update now
  recreates the app services (full `docker compose up -d`) and re-mounts any
  installed plugins, so the backend picks up the new `SELFHELP_FRONTEND_VERSION`
  and the CMS System page shows the version that was actually deployed.

### Changed
- **Environment dialog uses the standard modal wrapper.** The Environment editor
  now renders through a shared header/body/footer `Dialog` with a single scroll
  region (no more nested/double scrollbars), matching the CMS modal layout.
- **Backup run time uses a time picker + clearer save state.** The schedule "Run
  time" is now a native `HH:MM` time control, and the **Save schedule** button is
  flanked by **Unsaved changes** / **Saved** badges so it is obvious when edits
  are pending.

### Documentation
- New [Database access](docs/operator/database-access.md) runbook: connect to an
  instance's MySQL from the CLI or MySQL Workbench (Windows + Linux) over an SSH
  tunnel, with the credential locations and a temporary-exposure recipe.
- Documented that the one-shot `volume-init` container exiting `Exited (0)` /
  `Completed` is normal (not a half-started stack) in the quick reference and
  troubleshooting guides.

## [1.4.4] - 2026-06-15

### Added
- **One combined Update dialog.** The separate "Update…" and "Update
  frontend…" buttons on the instance detail page are now a single **Update…**
  dialog with a mode switch: **SelfHelp core (+ matching frontend)** or
  **Frontend only (keep core)**. Each mode explains what moves and what stays —
  updating the core moves the frontend to a release the new core supports in the
  *same* operation (the dry-run shows both exact versions before anything
  changes), while frontend-only swaps just the stateless frontend container. The
  core dry-run plan now also shows the compatible frontend version that ships
  with the core update.
- **Rename an instance.** A new **Rename…** dialog (and CLI
  `instance rename <id> <displayName>` + `POST /api/instances/:id/name`) changes
  an instance's friendly display name without touching the immutable technical
  id, containers, volumes or routing — handy after a clone or a domain change.
  No restart, no downtime: it only rewrites the manifest + README.
- **Email dialog shows the current address.** The outbound-email dialog now
  shows the address mail is currently sent through (credentials masked) and
  documents how to point an instance at an institutional/relay SMTP that accepts
  mail from the server's network **without a password** (e.g. a university
  smarthost).
- **Operations: refresh + completion notifications.** The operations list has a
  manual **Refresh** button, and finishing any background operation now raises a
  toast and invalidates the instance/backups/operations queries so the whole UI
  reflects the new state immediately (no stale "watch operations" guesswork
  after a plugin install).
- **Cleaner environment-variable editor.** Newly added custom variables now
  appear in a clear, pinned "added" section at the bottom of the Environment
  dialog instead of being lost among the managed defaults.

### Changed
- **Frontend version picker loads frontend releases.** The frontend-update
  version dropdown now lists registry **frontend** versions (it previously fed
  from the core feed), so the offered targets match what the frontend channel
  actually publishes.

### Fixed
- **Installing a plugin now makes it work immediately — no more "No route found
  for `…/admin/plugins/<id>/…`" 404 after install.** The production backend
  images bake an empty Symfony cache and warm it lazily on first boot, and the
  managed-install drain finishes with `docker compose restart` (which keeps the
  container's writable layer). So the kernel that came back up reused the
  compiled DI container + dumped router matcher from **before** the plugin
  existed: the plugin's Symfony bundle was never registered and its DB-synced
  `api_routes` rows never entered the router — the admin API 404'd and the host
  reported *"plugin could not be mounted"* even though the row, vendor and
  bundles file were all present (seen with SurveyJS's `surveys` admin route).
  The drain now recompiles each Symfony service's cache (`cache:clear`, with a
  delete-and-lazy-rewarm fallback) **after** the bundles file is in place and
  **before** the restart, across install/update/uninstall, post-core-update
  reinstall, and snapshot restore. The SurveyJS plugin itself needed no change.
- **Restoring a backup that had plugins no longer leaves a half-restored
  instance.** A restore repopulates the database (plugins recorded as installed)
  and the plugin volumes, but the freshly recreated Symfony containers started
  **without** the composer-installed bundles — so the host reported *"plugin
  could not be mounted / runtime import failed"* and the public plugin ESM
  artifacts 404'd. The restore now re-extracts the composer-state snapshot from
  the restored plugin volume into backend/worker/scheduler and restarts them
  (exactly like an address/mailer/env recreate), so the plugin runtime and its
  public artifacts are served again. `instanceRestore` reports the new
  `pluginsRemounted` flag.

### Removed
- **Campus/OIDC (UniBE login) auth leftovers.** The unused OpenID-Connect /
  campus-account sign-in scaffolding has been removed: operator authentication
  is **local only** (email + password), and remote access is via an SSH tunnel
  to the localhost-bound web UI as documented. The `admin allow-email` CLI
  command and the OIDC email allow-list were dropped (old operator stores still
  load — the obsolete `allowedEmails` field is ignored and dropped on next
  save).

### Security
- **Outbound-email DSN never reveals stored credentials.** The Email dialog
  redacts the configured mailer DSN (user/password masked) while still showing
  the active sender, so a saved SMTP password is never echoed back to the
  browser.

## [1.4.3] - 2026-06-15

### Added
- **Frontend-only updates.** The frontend ships on its own cadence in the
  registry, so an instance already on the newest **core** can still have a newer
  compatible **frontend** (e.g. core `0.1.4` + frontend `0.1.5` → `0.1.7`).
  The manager can now update the frontend independently:
  - New resolver `resolveFrontendUpdate()` picks the newest registry frontend
    that satisfies both the instance's current core range and the frontend's own
    `requiredCoreRange`, honouring channel + security advisories and refusing
    downgrades.
  - New engine `planFrontendUpdate()` / `executeFrontendUpdate()` do the
    **lightweight** swap: snapshot config → pull **only** the frontend image →
    recreate **only** the frontend container (`--no-deps`) → health-check, with
    automatic rollback. No database migration, no full backup, no maintenance
    window (the frontend is stateless); the core stack and all volumes are left
    untouched.
  - New CLI command **`instance update-frontend <id>`** (with `--version`,
    `--channel`, `--dry-run`). The existing **`instance update`** now also offers
    a frontend-only update automatically when the core is already up to date.
  - New BFF routes `POST /api/instances/:id/frontend-update/dry-run` and
    `POST /api/instances/:id/frontend-update`, and a dedicated **Update
    frontend…** dialog on the instance detail page (dry-run first, execute
    second).
  - The CMS → manager operation protocol (`PendingOperation`) gained
    `kind: 'core' | 'frontend'` + `targetFrontendVersion`, so a frontend-only
    update can also be requested from the CMS and drained by the manager.

### Fixed
- **Health check service badges now show correct colors** — the service badge color check was looking for state `'running'` but the health check API returns `'healthy'`, `'degraded'`, etc. Changed the condition to check for `'healthy'` so healthy services display teal (green) instead of red.

## [1.4.2] - 2026-06-15

### Added
- **Environment editor for installed instances.** The instance detail page has a
  new **Environment…** dialog (and the API/CLI gained `instance get-env` /
  `instance set-env`) to view and edit an instance's non-secret runtime
  configuration: tune editable defaults (`JWT_TOKEN_TTL`, `FRONTEND_BASE_URL`,
  `CORS_ALLOW_ORIGIN`, `APP_DEBUG`, …) and add custom variables. Overrides are
  persisted on the instance manifest (`envOverrides`) and re-merged into the
  generated `.env` on every later regeneration (update/clone/address change), so
  operator tuning is never silently reverted. Manager-owned structural keys
  (instance id, internal Docker URLs, JWT key paths, plugin trust, version
  stamps) are shown **read-only** and can never be overridden, and `MAILER_DSN`
  is intentionally read-only here so SMTP credentials keep going through the
  Email dialog into the restricted `secrets.env` — they never land in the
  non-secret `.env`. Secrets are never displayed by the editor.
- **URL-based navigation** — the operations console now updates the browser URL when navigating between dashboard, instances, and the create wizard. State is preserved on page refresh, allowing operators to share links or return to their previous view after a reload.
- **Clickable domain in instance list and detail** — the domain field in both the instances list table and the instance detail page is now a clickable link that opens in a new tab, allowing operators to quickly navigate to their instances.
- **Help text for admin display name** — the admin name field in the create-instance wizard now includes descriptive help text explaining that it is an optional display name for the admin account.

### Changed
- **Smaller default button size** — all buttons in the GUI now use a smaller default size to prevent text cutoff and improve layout consistency across the interface.

### Fixed
- **Emailed links (account validation, password reset, welcome) now point at
  the instance, not `localhost:3000`.** The backend builds those links from
  `FRONTEND_BASE_URL`, which the generated instance `.env` never set, so it
  fell back to the backend's dev default `http://localhost:3000` — a port no
  real instance serves. The manager now writes `FRONTEND_BASE_URL` set to the
  instance's own public URL (host:port in local mode, `https://<domain>` in
  production). Existing instances pick it up on the next env apply / address
  change, or via the new environment editor.
- **URL-based navigation actually works now.** The console read its selected
  instance / create-wizard state from `useParams()`, but the shell never
  mounts any `<Route>` elements, so the params were always empty — clicking an
  instance or "New instance" changed the URL but the center pane never
  followed. The shell now derives its view from the location pathname
  (`parseConsoleRoute`), so sidebar navigation, the auto-opened first-run
  wizard, deep links and browser back/forward all work. This also fixes the
  web UI test suite, which crashed with "useNavigate() may be used only in the
  context of a <Router>" because the shared test renderer had no router
  context.

## [1.4.1] - 2026-06-13

### Fixed
- **Operation journal records are written atomically** (temp file + rename),
  so a console poll that lands while an operation is completing can no longer
  read a half-written file and momentarily report the operation as missing.

## [1.4.0] - 2026-06-13

### Added
- **Scheduled backups with GFS retention.** Every instance can now take an
  automatic nightly backup: `sh-manager instance backup-schedule <id>
  --enable [--time HH:MM --keep-daily N --keep-weekly N --keep-monthly N
  --max-age-days N]` stores the policy in the instance manifest
  (schema-validated), the web console runs due backups from a built-in
  scheduler loop (disable with `SHM_BACKUP_SCHEDULER=0`), and
  `sh-manager server run-scheduled-backups` is the one-shot trigger for
  cron/systemd hosts (ready-made units under `deploy/`). Runs are journaled,
  audited, take the per-instance operation lock, record state in
  `manager/backup-scheduler.json` (a GUI loop and a cron job can coexist
  without double-running), catch up exactly once after downtime, and skip
  with a journaled warning when free disk is below ~2× the newest backup.
- **GFS pruning with safety invariants.** Scheduled backups are retained on
  grandfather-father-son slots (recent dailies, Monday weeklies,
  1st-of-month monthlies, hard max age); `sh-manager instance backup-prune
  <id> [--dry-run]` previews/applies the keep/delete plan with an explicit
  reason per backup. Manual backups are **never** auto-pruned, `pre_update`/
  `pre_restore` safety backups only beyond max age, the newest scheduled
  backup never, and pruning never touches anything but this instance's own
  backup directories.
- **Backup origins.** Every backup manifest now records why it exists —
  `manual`, `scheduled`, `pre_update` or `pre_restore` (older backups
  without the field count as `manual`) — shown as badges in the console's
  Backups panel next to the schedule card (policy, last/next run, current
  size and projected steady-state footprint) and served via
  `GET/PUT /api/instances/:id/backup-schedule`.
- **Manual QA test plan.** `docs/qa/manual-test-plan.md` (structured,
  severity-tagged cases for every operator workflow incl. the v1.3.0
  surface: first-run setup, wrapper verbs, purge, in-CMS plugin pipeline,
  mailer) + `docs/qa/results-template.md` for per-release sign-off, with
  Windows and Linux appendices.
- New operator runbook [docs/operator/scheduled-backups.md](docs/operator/scheduled-backups.md);
  nightly e2e now exercises the one-shot scheduler, GFS prune, double-run
  guard, the managed plugin drain pipeline and `server purge` against real
  Docker.

### Fixed
- **Same-day backups no longer overwrite each other.** A second
  `instance backup` on the same day silently reused sequence `001` and
  clobbered the first backup's directory; the next free sequence is now
  picked automatically (`--seq` still wins for explicit control).
- **Operation journal records are written atomically** (temp file + rename),
  so a console poll that lands while an operation is completing can no longer
  read a half-written file and momentarily report the operation as missing.

## [1.3.0] - 2026-06-12

### Changed
- **One web UI: the operations console.** The separate unauthenticated
  "bootstrap" wizard mode is gone — `sh-manager web` always starts the
  authenticated multi-instance console, on a fresh state folder too. The
  `--mode bootstrap|persistent`, `--persist` flags and `SHM_WEB_MODE`/
  `SHM_WEB_PERSIST` variables were removed; the operator store is always on.
- **First-run setup in the browser** — when no operator account exists yet,
  the console shows a one-time "Create the operator account" screen
  (`POST /api/setup/operator`: localhost-only, pre-auth, rejected with `409`
  as soon as any operator exists, password-strength-checked, signs you in
  immediately). `sh-manager admin create` keeps working as the CLI
  alternative.
- **Create-instance wizard is a guided full page** (not a modal): Welcome →
  Preflight (auto-run environment checks) → Basics → Address → Release →
  Review → live journaled install log. It opens automatically when the
  server has no instances yet. The **first** install initializes the server
  (shared proxy + inventory) in the same flow — `server init` is no longer a
  separate GUI step — and production first-installs ask for the Let's
  Encrypt e-mail.

### Added
- **In-CMS plugin installs complete end to end on managed servers.**
  Production instances run the backend in `managed` plugin install mode: the
  CMS verifies the plugin signature and stages the artifacts, then parks the
  operation for an external operator — previously nothing played that role,
  so installs sat in "running" forever. The manager is now that operator: the
  CMS poller (and `sh-manager instance process-operations <id>`) detects
  parked plugin install/update/uninstall operations, runs the runbook's
  composer step inside the backend container, finalizes via
  `selfhelp:plugin:run-operation` (self-healing half-finalized operations
  with `selfhelp:plugin:repair`), enables new installs, snapshots the
  composer state (vendor, composer files, plugin lock, generated bundles) to
  the instance's plugin volume, syncs worker + scheduler from the snapshot
  (byte-identical state, no per-container composer runs or GitHub rate
  limits), and restarts the Symfony services.
- **Plugins survive recreates and core updates.** Composer-installed plugin
  state lives in each container's writable layer and was silently lost on
  recreate. Core updates now re-require every installed plugin against the
  new core after migrations (gated by the same health check + rollback as
  the rest of the update), and address/mailer changes restore the plugin
  snapshot when the recreate dropped it. Standalone-archive plugins (no
  upstream repository in the manifest) are re-required from their verified
  package copy on the plugin volume via a composer path repo.
- **Instances receive the plugin trust environment.** Generated `.env` now
  carries `SELFHELP_PLUGIN_TRUSTED_KEYS` (the manager's own active trusted
  keys), `SELFHELP_PLUGIN_REQUIRE_SIGNATURE=true`, and
  `SELFHELP_PLUGIN_DEFAULT_REGISTRY_URL` (the registry the instance was
  installed from), so the CMS verifies plugin signatures against exactly the
  keys the manager trusts and lists plugins from the same registry the
  manager resolves releases against.
- **Outbound mail (SMTP) configuration end to end** — new
  `sh-manager instance install --mailer-dsn <dsn>` option, a
  `sh-manager instance mailer <id> [--set <dsn> | --clear] [--no-restart]`
  command, BFF routes (`GET/POST /api/instances/:id/mailer`), a mailer field
  in the create wizard, and an **Email…** dialog on the instance workspace.
  DSNs are validated everywhere, credentials are redacted in every display,
  and clearing falls back to the bundled Mailpit.
- **Full server purge** — `sh-manager server purge --confirm "purge selfhelp"`
  removes every instance (containers, volumes, data, secrets), the shared
  Traefik proxy, and all server state; backups are kept unless
  `--delete-backups`. The repeated literal confirmation is required.
- **`sh-manager server status`** — reports whether the state root is
  initialized, the manager version, and the managed instances (used by the
  GUI to drive the first-install flow).
- **Stateless server endpoints for the console** — `GET /api/server/status`
  and `POST /api/server/preflight` (Docker, internet, registry, resources in
  one call) replace the wizard-session check routes.
- **Manager lifecycle verbs in the wrapper script** — `shm up` (background
  GUI), `shm down` (stop; instances keep running), `shm update`
  (self-update), `shm reinstall` (down + fresh pull + up). All state lives
  in the state folder, so a reinstalled manager reconnects to existing
  instances automatically.

### Fixed
- **In-CMS plugin installs no longer die with `mkdir(): Permission denied`** —
  the engine creates the per-instance data volumes (`uploads`,
  `plugin_artifacts`, `plugin_artifacts_public`) root-owned, but the core
  images run PHP as `www-data`. Generated compose now includes a one-shot
  `volume-init` service (backend image run as root) that hands the mount
  points to `www-data` before backend/worker/scheduler start, so plugin
  installs and file uploads work on a fresh instance.
- **Seamless self-update from pre-1.3 GUI containers** — `self-update`
  recreates the `sh-manager-web` container with its old arguments, which
  included the removed `--mode persistent`/`--persist` flags. The `web`
  command now accepts (and ignores) them, so an updated manager comes back
  up instead of crash-looping on an unknown option.
- **Re-bootstrap after a purge** — folders holding only retained backups
  (what `server purge` / `full_delete` keep on purpose) no longer block the
  next `server init` / first install as a "partial or foreign install".

### Removed
- The bootstrap wizard UI (`features/bootstrap/`), the server-side wizard
  state machine (`wizard.ts`), and the wizard session API
  (`/api/config`, `/api/advance`, `/api/back`, `/api/check/:step`,
  `/api/install`).

### Documentation
- Operator docs reworked for the single-console flow: install, Windows
  quickstart (manager lifecycle: update/remove/reinstall + purge cleanup),
  GUI instance management (first-run setup, new wizard, mailer, endpoint
  table), quick reference (mailer + purge + lifecycle commands), security
  hardening, post-install checklist, troubleshooting, operations runbook,
  architecture and developer guide.

## [1.2.0] - 2026-06-12

### Added
- **Admin-shell console layout** — the operations console now uses the same
  Mantine admin-panel structure as the SelfHelp CMS UI: instances in a left
  sidebar (live status dots, domain/port), the dashboard or the selected
  instance's workspace in the center, and the operator + sign-out in the
  header.
- **Multi-step create-instance wizard** — creating an instance from the
  console now uses the same guided step form as the bootstrap installer
  (Basics → Address → Release → Review & install) in a 90%-width modal that
  only closes through Cancel/Close. The install streams its journaled log
  live inside the wizard, and the new instance can be opened directly when
  it finishes.
- **Registry version dropdowns everywhere** — the create wizard and the
  update dialog pick versions from the verified release registry
  (`GET /api/registry/versions`); versions are never typed by hand (free
  text remains only as an offline fallback).
- **Change address from the manager** — new `sh-manager instance
  set-address <id> --domain <domain> | --port <port>` CLI command, BFF route
  (`POST /api/instances/:id/address`) and GUI dialog. Rewrites the generated
  config/routing (incl. the Mercure route), updates the inventory and
  restarts the instance automatically (`--no-restart` to defer,
  `--strict-dns` to hard-fail on wrong DNS). Re-applying the same address is
  a supported config-repair path.
- **New operator runbook** [`docs/operator/domains-and-ports.md`](docs/operator/domains-and-ports.md)
  — DNS setup for production instances, changing domains/ports from GUI and
  CLI, how routing is wired, and troubleshooting.
- **Shared instance validation module** (`apps/web/src/instance-validation.ts`)
  — create/clone/set-address requests are validated by the same pure module
  on the server routes, the CLI actions and the UI forms, so the wizard can
  never submit what the server would reject.

### Fixed
- **Mercure events 503 on installed instances** — `MERCURE_PUBLIC_URL` now
  resolves mode-aware: local instances use the internal
  `http://mercure/.well-known/mercure` hub (the frontend BFF could never
  reach the previously configured public URL from inside the Docker
  network), and production instances route
  `https://<domain>/.well-known/mercure` through Traefik to the Mercure
  container (new router labels + proxy-network attachment).
- **Sign-out and all console actions failing with 403 after a page reload**
  — the session cookie survived reloads but the in-memory CSRF token did
  not. `GET /api/state` now returns the operator's session (email, roles,
  CSRF token) and the client re-captures it, so every POST works after a
  reload.
- **Clone now works for both port- and domain-published instances** — the
  clone path (CLI, BFF, GUI dialog) is mode-aware: production sources
  require a new domain, local sources a new `127.0.0.1` port
  (`--target-local-port`). Previously a domain was demanded universally,
  which broke local clones.
- **Environment checks stuck on "Pending"** — the dashboard runs all four
  checks (Docker, internet, registry, resources) automatically on load;
  every check remains re-runnable on demand.
- **Manager crash while piping the database dump into a clone/restore** —
  MySQL's first-boot temp-init server could answer the readiness probe and
  then restart, breaking the import's stdin pipe with an unhandled
  `write EOF` that killed the whole manager process. The pipe error is now
  handled and the idempotent import retries (up to 3 attempts) after
  re-confirming readiness.
- **Stuck state after a manager crash** — operations orphaned in the
  `running` state are marked failed at boot (no more endless spinner), and
  a per-instance lock whose owning process is gone no longer keeps every
  action button disabled.

## [1.1.2] - 2026-06-12

### Fixed
- **Login form card width increased** — the sign-in card width is now 640px (was 540px) to prevent text cutoff in the "No operator accounts yet" alert box.

## [1.1.1] - 2026-06-12

### Changed
- **`sh-manager web` auto-detects its mode** — persistent (management console
  with operator sign-in) once the server is initialized
  (`<root>/selfhelp.server.json` exists), bootstrap (install wizard) on a
  fresh state folder. Previously the default was always `bootstrap`, so an
  updated manager kept showing the wizard instead of the console. An explicit
  `--mode` / `SHM_WEB_MODE` still overrides; startup logs say which mode was
  auto-selected and why.
- **`admin create` generates a password when `--password` is omitted** and
  prints it exactly once (same convention as the install's generated CMS
  admin password). Previously the command failed without `--password` /
  `SELFHELP_MANAGER_ADMIN_PASSWORD`.

### Added
- **First-run operator guidance** — in persistent mode with no operator
  accounts yet, the server logs the exact `admin create` command at startup,
  and the sign-in screen shows the same hint (via the new pre-auth
  `GET /api/auth/meta` endpoint, which returns only the mode and an
  operators-configured boolean). The wizard success screen now ends with a
  "Next: the management console" panel covering operator creation.

## [1.1.0] - 2026-06-12

### Added
- **GUI instance management (persistent web mode)** — the operations console
  now manages the full instance lifecycle from the browser: instances list
  (inventory state, `broken` instances surface a repair hint instead of
  crashing), instance detail with on-demand health check, backups
  (create/restore with automatic pre-restore backup and typed confirmation),
  dry-run-gated updates, clone (always fresh secrets), staged remove
  (`disable` / remove-containers-keep-data / `full_delete` with typed
  confirmation), create, and a live operation log viewer. Everything runs
  through a file-backed operation journal (redacted logs), a JSONL audit log,
  per-instance locks and HTTP 202 semantics; the APIs require login + CSRF
  and exist only in persistent mode. See
  `docs/operator/gui-instance-management.md`.
- **Per-instance manager token** — install now generates a
  `SELFHELP_MANAGER_TOKEN` per instance and injects it via the 0600
  `secrets.env`, enabling the CMS→Manager update loop out of the box.
  `instance update` / `instance repair` backfill the token for pre-token
  installs (existing tokens never change).
- **Exec-based operations transport (new default)** — `process-operations`
  talks to the backend by `docker compose exec` into the instance's backend
  container using the container's own token; no published backend port and no
  host-side token handling. `--backend-url` still selects the HTTP client for
  remote setups.
- **Background CMS poller (persistent web mode)** — CMS-requested updates are
  drained automatically every 15 s through the same journal + locks, so a
  documented admin "Update now" actually executes without a cron entry.
- **`instance repair`** — reconstructs a missing/invalid manifest from the
  newest backup snapshot or from inventory + lock + compose; `instance list`
  marks damaged instances `broken` with the repair command instead of
  failing.
- **MySQL major-upgrade approval in the GUI** — the dry-run plan now carries
  the MySQL major-upgrade decision (`plan.mysqlMajor`); when the target
  release demands manual approval the update dialog shows a one-way warning
  plus an explicit approval checkbox (mirrors `--approve-mysql-major`).

### Changed
- The e2e CMS-loop scenario exercises the SHIPPED wiring: the
  install-generated token + the exec transport (no hand-wired token, no
  exposed backend port for the loop path).
- Wrapper scripts and the CLI strip a redundant leading `sh-manager` token,
  so pasted `./shm.ps1 sh-manager …` commands work; missing-manifest errors
  now name the state root, known instances and the repair command.
- Operator docs/deploy examples updated for the exec-transport default; the
  GUI guide documents the security model (auth + CSRF + journal/audit), the
  SSH-tunnel-only access pattern, on-demand health checks, and that the
  generated admin password is never shown in the browser (read the 0600
  server-side file over SSH).

### Fixed
- Wrong backup/support-bundle command snippets in the web console; all
  snippets are wrapper-aware now.
- Instance-id validation in the BFF routes and lockfiles is lowercase-only,
  matching what the CLI actually creates (uppercase aliases could collide on
  case-insensitive filesystems).

## [1.0.14] - 2026-06-11

### Fixed
- **`instance install --version <x>` / `instance update --version <x>` work
  again** — the root `--version` flag (print the manager version) was
  registered globally, and commander consumes global options anywhere in the
  argv, so any command carrying its own `--version <version>` option printed
  the manager version and exited without doing anything. This is why
  installing a pinned/tagged SelfHelp version "silently did nothing". The
  manager-version flag now only acts on a bare `sh-manager --version` (also
  `-V` / `version`); everywhere else `--version` belongs to the subcommand.
  Covered by argv-level regression tests that spawn the real entrypoint.

## [1.0.13] - 2026-06-11

### Fixed
- **The image reports its real version again** — releases 1.0.11 and 1.0.12
  were tagged with only the root `package.json` bumped, while the
  `MANAGER_VERSION` constant (what `--version`, the web UI header, the
  inventory stamp, and `self-update` all use) stayed at `1.0.10`. Those images
  therefore mis-reported themselves and `self-update` saw a permanently
  available update. The constant is now pinned to `package.json` by a unit
  test, so the release gate fails on any future drift. Use 1.0.13 (or later);
  skip 1.0.11/1.0.12.

## [1.0.12] - 2026-06-11

### Fixed
- **`self-update` now also refreshes a stale web GUI container when the
  manager version is already current** — upgrading through an older manager
  (whose `self-update` only printed the pull command) left the long-running
  `sh-manager-web` container on the previous image forever: by the time the
  new CLI ran, the version check said "up to date" and the GUI was never
  restarted. `self-update` now compares the GUI container's image ID with the
  freshly pulled image and recreates the container when they differ, so "up
  to date" implies the GUI is too. It also no longer restarts a container
  that already runs the exact current image.

## [1.0.11] - 2026-06-11

### Added
- **The generated admin password is now delivered, not just generated** — it
  is saved to the owner-only file `<instance>/secrets/admin_password` (0600)
  and returned once on the install response: the CLI prints it together with
  the file path, and the web wizard's success screen shows it masked behind a
  *Reveal* button with copy support (one-shot: it is never part of wizard
  state, `/api/state`, or any check detail, and disappears on reload — the
  screen then points at the server-side file instead). A resumed install
  reuses the persisted password instead of regenerating it, so the admin user
  always matches the file. A password you supply yourself (`--admin-password`)
  is still used as-is and never written to disk. Previously the web wizard
  generated a password, created the admin with it, and threw it away — it was
  unrecoverable anywhere.
- **`sh-manager self-update` now applies the update** instead of only printing
  instructions. On the Docker image it pulls the new image tags and — when the
  `sh-manager-web` GUI container is running — recreates it on the new image
  with the same port mapping, mounts, environment, and command (`--check`
  keeps the old report-only behaviour, exit `2` = update available). On a
  source checkout it runs `git pull --ff-only`, `npm ci`, and `npm run build`.
  When the updater runs *inside* the GUI container itself it stages everything
  and prints the one command to finish from the host (a container cannot
  safely replace itself).

### Fixed
- **Installs onto a stale MySQL volume now fail fast with remediation instead
  of timing out after 2 minutes** — when an instance's `mysql_data` volume was
  initialised by an earlier install attempt with different generated secrets
  (manager < 1.0.10 regenerated secrets on retry; MySQL only applies
  `MYSQL_USER`/`MYSQL_PASSWORD` when an empty volume initialises), every
  `wait_db` probe died with `SQLSTATE[HY000] [1045] Access denied` until the
  60-attempt timeout. The DB-wait and console-wait loops now recognise
  persistent authentication failures (3 consecutive probes), stop immediately,
  and explain the two ways out: remove the instance **including volumes** and
  reinstall, or restore the original `secrets/secrets.env`.

## [1.0.10] - 2026-06-11

### Fixed
- **Install no longer dies at `wait_db` with `Unable to read the "/app/.env"
  environment file`** — Symfony's runtime boots a dotenv file on every request
  and console command, but the published core images up to 0.1.2 bake no
  `/app/.env`, so every `php bin/console …` the installer execs (DB wait,
  migrations, admin creation) fatally aborted and provisioning stopped at
  `wait_db`. Compose `env_file` entries only inject process env vars — they
  never create the file — so the generated instance compose now bind-mounts
  the instance's non-secret `.env` read-only at `/app/.env` in the
  backend/worker/scheduler containers. The generated `.env` now also carries
  every backend env var that has no config default (`APP_DEBUG`,
  `JWT_TOKEN_TTL`, `JWT_REFRESH_TOKEN_TTL`, `CORS_ALLOW_ORIGIN`,
  `MAILER_DSN`), so it fully substitutes the image-baked defaults file it
  shadows on newer cores. Installs work for every published core again;
  images that bake their own `/app/.env` are unaffected (real container env
  always overrides dotenv values).
- **Reinstalling after a failed install now continues automatically, even
  after the manager was updated/restarted in between** — the wizard's retry
  acknowledgement only lived in memory, so pulling a fixed manager image and
  re-running the install was refused with "This server is already
  bootstrapped"; operators had to delete the state folder first. The web
  install now resumes a half-finished bootstrap server-side: when the on-disk
  state contains no instance other than the one being (re)installed, `server
  init` proceeds as an import/repair — the inventory, proxy config and
  instance folder are reconciled and the existing on-disk secrets are reused
  (the already-initialised MySQL volume keeps matching its credentials).
  Nothing has to be deleted to try again. A server hosting *other* instances
  still refuses without an explicit import acknowledgement.
- **Worker/scheduler containers no longer show "(unhealthy)" in `docker ps`** —
  the published worker/scheduler images are built from the backend image and
  inherit its FrankenPHP `HEALTHCHECK` (a curl against the Caddy admin endpoint
  `:2019`), but both services run console loops, not FrankenPHP, so the
  inherited check could never pass and permanently branded working containers
  unhealthy. The generated compose now disables that inherited healthcheck for
  `worker` and `scheduler`; `restart: unless-stopped` remains their liveness
  mechanism and the manager's health verdict (which probes the public HTTP
  surface) is unaffected.

## [1.0.9] - 2026-06-11

### Fixed
- **Release image publishing no longer fails with "unknown blob"** — the
  `manager-release` workflow now provisions a BuildKit (docker-container)
  builder so the release image is pushed to GHCR directly by BuildKit instead
  of through the runner's Docker daemon, whose push path aborted the v1.0.8
  release with `ERROR: unknown blob` after every layer had already uploaded.
  Provenance attestations are disabled explicitly so the pushed artifact stays
  a plain image manifest whose digest is what cosign signs and operators pin.

## [1.0.8] - 2026-06-11

### Fixed
- **CMS admin login no longer 500s on Linux hosts** — the per-instance JWT
  keypair (`secrets/jwt/`) was written `0600`/`0700` like every other secret,
  but it is bind-mounted into the backend/worker/scheduler containers whose
  PHP runs as `www-data` (uid 33). On a Linux host uid 33 could not read the
  keys, so JWT signing failed and every `/auth/login` returned an opaque 500
  while health checks and provisioning (which never touch the keys) stayed
  green — Windows/macOS Docker Desktop masked the bug with permissive mount
  modes. The keypair is now written `0644`/`0755`; this leaks nothing usable
  because the private key is AES-256 passphrase-encrypted and the passphrase
  stays in `0600` files outside the mounted directory.
- **Docker e2e failures are self-explanatory** — when an e2e login or backend
  health wait fails, the harness now dumps the tail of each qa-e2e backend's
  `var/log/prod.log` (where Symfony logs the real exception) into the test
  output, so a CI failure shows the root cause instead of an opaque 500.

## [1.0.7] - 2026-06-11

### Added
- **Manager version in the GUI** — the BFF now includes its version in every
  state snapshot and the web UI shows it in the header brand and footer
  (bootstrap wizard and operations console alike).
- **SelfHelp version dropdown** — the wizard's instance step fetches the
  available core versions from the registry (`GET /api/registry/versions`,
  server-authoritative: the registry URL always comes from the server-side
  wizard state, never the browser) and offers them in a dropdown next to
  "latest". If the list cannot be loaded it degrades to the previous free-text
  input. The Registry URL field stays visible but is locked to the official
  signed registry.
- **Named manager containers** — the generated wrapper now starts the GUI as
  `sh-manager-web` and CLI runs as `sh-manager-cli-<pid>` instead of random
  Docker names, so the manager is recognizable in `docker ps`/Docker Desktop.

### Fixed
- **Retry after a failed install no longer dead-ends** — re-running the wizard
  install used to fail with "This server is already bootstrapped…" because the
  first attempt had already written the inventory/proxy/instance dir. The
  wizard retry now re-runs `server init` in import/reconcile mode (existing
  inventory instances are preserved), re-installing the *same* instance id over
  its own domain/port is allowed, and `instance install` reuses the secrets
  already on disk so a database volume initialized by the first attempt still
  matches its credentials on the retry.
- **Provisioning failures now say what failed** — the install outcome carries
  the failing provision step (`wait_db`, `migrations`, `admin`, …) and its
  detail instead of a bare "Provisioning failed.", and the wizard checklist
  marks the step that actually failed rather than wherever the progress
  animation happened to stop.
- **`shm web` prints a browsable URL** — the listen message now shows
  `http://localhost:8765` (the published loopback port) instead of the
  in-container bind address `http://0.0.0.0:8765`, which is not reachable from
  the host browser.

## [1.0.6] - 2026-06-11

Version bump to 1.0.6.

### Fixed
- **Backend Mercure hub URL** — generated instances now set `MERCURE_URL`
  (`http://mercure/.well-known/mercure`) in the non-secret instance `.env`,
  and the compose `mercure` service serves plain HTTP on the private network
  (`SERVER_NAME=:80`). Without the URL the backend's hub service failed to
  instantiate (`new Hub(null)` TypeError), 500-ing every request and breaking
  `app:create-admin-user` during provisioning — the docker e2e failure.
- **Redis password enforcement** — the generated compose escaped
  (`$$REDIS_PASSWORD`) the redis command/healthcheck so the secret is expanded
  by the container shell from the secret env file instead of being interpolated
  (to empty) by `docker compose` at parse time. Redis now actually requires the
  generated password, and the misleading "REDIS_PASSWORD variable is not set"
  warnings on every compose call are gone. The scheduler tick variable uses the
  same container-time expansion.

## [0.1.5] - 2026-06-11

Windows-simplification release: mount any state folder, no Docker Desktop VM
paths, and the image distributes its own wrapper script.

### Added
- **Engine-side path auto-discovery** — when the manager runs containerized,
  it inspects its own container through the mounted socket and learns where
  the Docker ENGINE sees the state root. Generated compose bind sources
  (instance JWT keys, proxy Let's Encrypt storage) and backup/restore helper
  mounts are translated automatically. The state folder can now be mounted
  from anywhere (`-v D:\selfhelp:/opt/selfhelp` on Windows,
  `-v /home/me/selfhelp:/opt/selfhelp` on Linux) — the previous
  same-path-on-both-sides requirement and the Windows
  `/run/desktop/mnt/host/…` VM-path trick are gone. Same-path mounts (the
  documented Linux production layout) discover an identity mapping and keep
  emitting today's relative binds — zero behavior change. Escape hatch:
  `SELFHELP_ENGINE_ROOT=<path|off>`.
- **`sh-manager wrapper --shell powershell|bash`** — prints a small `shm`
  wrapper script so the image distributes its own convenience layer
  (`docker run --rm … wrapper --shell powershell > shm.ps1`). The script
  mounts the socket + state folder (default: the folder the script is saved
  in), forwards every command, publishes the GUI loopback-only for
  `shm web` (`--web-port`, default 8765), survives Git Bash path mangling
  (`cygpath` + `MSYS_NO_PATHCONV`), and supports `--state-root`/`--image`
  overrides.

### Changed
- **`instance install --registry` is now optional** and defaults to the
  official registry (`https://humdek-unibe-ch.github.io/sh2-plugin-registry/`),
  matching the web wizard. Release signature/checksum verification against the
  pinned trusted keys is unaffected by the registry URL.
- **Windows quickstart rewritten** around the generated wrapper: pull →
  generate `shm.ps1` → `server init` → `instance install` → `shm web`, with
  PowerShell as the primary shell and no manual path translation anywhere.
  `install.md`, `quick-reference.md`, and the README follow the new flow, and
  the "not initialized" CLI hint now points at the wrapper.

## [0.1.4] - 2026-06-10

Windows-testing + self-update release: the Docker image is now first-class on
Docker Desktop (Windows/macOS), `server init` actually brings the shared proxy
up, and both the CLI and the GUI can tell you when a newer manager is released.

### Added
- **`sh-manager self-update`** — checks the official GitHub releases feed and
  prints the exact update commands for the detected runtime (Docker image →
  `docker pull …`, source checkout → `git pull && npm ci && npm run build`).
  Exit code `2` means "update available" so cron/scripts can branch on it.
  Network failures degrade to a clear message, never a crash.
- **GUI update visibility** — the persistent operations console now shows a
  "Manager version" card with the installed version, an "Up to date /
  Update available" badge, release-notes link, and the copy-paste update
  commands (`GET /api/manager/update-check` on the manager BFF).
- **`server init` now creates the shared proxy network** (`selfhelp_proxy`)
  idempotently and, in production mode, starts the Traefik proxy container —
  previously the first `instance install --up` failed with "network declared
  as external, but could not be found" unless the operator created it by hand.
  `instance install --up` also re-ensures the network for servers bootstrapped
  by older managers. Local mode creates the network but starts no proxy (no
  80/443 grab on dev machines).
- **Containerised health probes work on Docker Desktop** — when the manager
  runs inside a container, health probes against `http://localhost:<port>`
  (local-mode instances publish on the host) are rewritten to
  `host.docker.internal` automatically. Override or disable with
  `SELFHELP_LOCALHOST_PROBE_HOST` (plain Linux engines:
  `--add-host=host.docker.internal:host-gateway`).
- **`sh-manager web`** — the web UI (install wizard / operations console) is
  now a first-class CLI subcommand, so the published Docker image can serve
  the GUI directly:
  `docker run -p 127.0.0.1:8765:8765 … sh-manager:latest web --host 0.0.0.0`.
  `sh-manager-web` still works and now shares the same composition root
  (`apps/web/src/main.ts`).
- **Windows quickstart** (`docs/operator/windows-quickstart.md`) — copy-paste
  path from a fresh Docker Desktop to a running local instance using only the
  published image (no Node/git), including the Git Bash `MSYS_NO_PATHCONV`
  path-mangling fix, Docker Desktop path-parity root, multi-instance port
  layout, and the GUI/CMS/update walkthrough.

### Changed
- **Single source of truth for the manager version**: `MANAGER_VERSION` lives
  in `@shm/schemas` (`packages/schemas/src/version.ts`) and the CLI
  (`--version`), web UI, and inventory stamps all import it. A release now
  bumps two files (that constant + root `package.json`) instead of five.
- The "server not initialized" CLI hint now also explains the local mode
  variant and the Docker named-volume/`MSYS_NO_PATHCONV` pitfalls on Windows.

## [0.1.3] - 2026-06-10

The first actually *runnable* Docker image. `v0.1.1` built and pushed fine but
every container invocation died at startup (see Fixed). The interim `v0.1.2`
tag never produced an image either: its new build step crashed on CI's Node
(`import { console } from 'node:console'` is not a named export there), so the
release failed at the image build — fixed here by writing to
`process.stdout` instead.

### Fixed
- **Docker image was unusable** — any command (`instance list`, `--help`, the
  GUI) failed at startup with
  `ENOENT ... /app/dist/packages/schemas/examples/trusted-keys.json`. The
  compiled bins resolve their default trusted-keys file relative to
  `dist/apps/.../bin.js`, i.e. *inside* `dist/`, but the image copied the JSON
  assets next to `dist/` instead. `npm run build` now copies
  `packages/schemas/{keys,examples}` into `dist/` (`scripts/copy-dist-assets.mjs`),
  so the compiled tree is self-contained everywhere, not only in Docker.

### Security
- **The default trust anchor is now the pinned official production key**
  (`packages/schemas/keys/official-trusted-keys.json`, keyId `prod`) for both
  the CLI and the web UI. Previously the default pointed at the *dev fixture*
  keys (`packages/schemas/examples/trusted-keys.json`), whose private seed is
  public in this repo — an operator relying on the default would have accepted
  attacker-signed "releases". The dev fixture now has to be opted into
  explicitly via `SELFHELP_TRUSTED_KEYS`/`--trusted-keys` (tests and local
  rehearsals already do).

### Added
- **MPL-2.0 `LICENSE` file** at the repo root (the `package.json` already
  declared `MPL-2.0`; now the license text ships with the repo and image, like
  the other SelfHelp repositories).
- **`npm run headers:check`** (`scripts/check-spdx-headers.mts`) — CI-enforced
  gate (part of `npm run check`) that every tracked source file carries the
  MPL-2.0 SPDX header, mirroring the backend's `composer headers:check`.

## [0.1.1] - 2026-06-10

First release whose Docker image actually shipped — the `v0.1.0` tag never
produced an image because the release workflow failed before its first step
(see Fixed below).

### Added
- **Local Windows walkthrough** (`docs/operator/local-windows-walkthrough.md`):
  beginner-friendly, copy-paste guide for Windows + Docker Desktop — install the
  manager from source, install an instance with the GUI wizard and the CLI,
  publish a small update to a local dev-signed test registry, then update the
  instance via the manager and via the CMS request flow.

### Fixed
- **`manager-release` workflow could not run at all**: `aquasecurity/trivy-action`
  was pinned to the mutable `0.28.0` tag, which was deleted upstream after the
  March 2026 Trivy supply-chain compromise (GHSA-69fq-xp46-6x23), so GitHub
  failed the run at action-resolution time ("unable to find version 0.28.0").
  The action is now SHA-pinned to the immutable `0.35.0` release commit, the
  SARIF upload got the missing `security-events: write` permission, moved to
  `codeql-action/upload-sarif@v4` (v3 is deprecated December 2026), and is
  `continue-on-error` so an advisory upload can never block a tag release.
- Generated instance `.env` files now emit the version env names the backend
  actually reads: `SELFHELP_CMS_VERSION` (was the unconsumed `SELFHELP_VERSION`)
  and the new `SELFHELP_FRONTEND_VERSION` (deployed frontend image version).
  Without these the CMS admin system page reported the image's baked default and
  `Frontend: unknown` on managed installs.

## [0.1.0] - 2026-06-08

Initial release of the SelfHelp Manager for the SelfHelp `0.x` pre-release
platform line — the official Docker-only, connected installer, updater, and
multi-instance server manager.

### Added

- **Server bootstrap** — `server init` creates the single shared Traefik reverse
  proxy and the server inventory.
- **Instance install** — `instance install` from the one official signed registry
  (no building on the server), with optional full provisioning (wait for DB →
  migrate → create admin → install plugins → warm caches → health-check) and a
  generated admin password shown once and never persisted.
- **Version resolution** — semver + security advisories + core ⇄ frontend ⇄
  plugin ⇄ plugin-API compatibility (`@shm/resolver`).
- **Updates** — `instance update` with dry-run/preflight, backup-first execution,
  rollback-on-failure, and a destructive-migration risk gate. CMS-requested,
  instance-scoped updates via `instance process-operations` (the backend never
  trusts a browser-provided `instanceId`).
- **Backups & restore** — checksummed backup manifests (`instance backup`) and
  validated restores (`instance restore`) with explicit secret policy
  (`same_instance` preserves secrets, `restore_as_clone` regenerates them) plus a
  disaster-recovery import path.
- **Clone & remove** — isolated clones with fresh secrets (`instance clone`) and
  three-tier removal (`disable`, `remove_containers_keep_data`, `full_delete`)
  with typed confirmation for destructive deletes.
- **Plugin safe-mode & diagnostics** — `instance safe-mode enable|disable`,
  `instance health`, host `doctor`, and redacted `instance support-bundle`.
- **Operators & auth** — local operator accounts and OIDC email allowlist
  (`admin create|disable|role|allow-email|list|bootstrap-token`), with hashed
  passwords, sessions, and CSRF for the management UI (`@shm/auth`).
- **Web UI** — a localhost Vite **React SPA** plus a Node **BFF**: an install
  wizard (bootstrap mode, self-locking after install), an operations console
  (persistent mode), and operator login. The SPA is built on **React 19**,
  **Mantine 9**, **Tailwind 4**, and **@tanstack/react-query**, aligned with
  `sh-selfhelp_frontend`. The BFF binds to `127.0.0.1` by default, with a
  Host-header (DNS-rebinding) guard and session+CSRF auth in persistent mode.

### Security

- Ed25519-signed, SHA-256-checksummed releases verified against a trusted-keys
  file; unsigned/untrusted/`dev`-keyed releases refused in production.
- Canonical JSON byte-compatible with the registry signer and the host PHP
  `SignedPayloadBuilder`.
- No runtime container mounts the Docker socket (only the shared Traefik proxy,
  read-only), enforced by `@shm/docker` guards.
- `docker compose down -v` and MySQL-volume deletion are blocked; instance data
  survives updates and non-destructive removals.
- Support bundles are redacted and re-scanned for residual secrets before being
  written.

### Documentation

- Added the `docs/` tree: architecture, developer guide, release & publishing,
  and operator runbooks (install, update, backup-restore, clone-remove,
  safe-mode-and-recovery, support-bundle, security-hardening).
- Added `AGENTS.md` (repository contract) and this changelog.
