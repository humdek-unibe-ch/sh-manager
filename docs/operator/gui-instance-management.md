# Manage instances from the GUI

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `1.2.0+`)
Last verified: 2026-06-12
Source of truth: `apps/web/src/server.ts`, `apps/web/src/instances.ts`, `apps/web/src/jobs.ts`, `apps/web/src/poller.ts`, `apps/web/src/ui/features/manager/`

The web UI is **one operations console** that manages the full instance
lifecycle from the browser: list and inspect instances, run health checks,
browse backups, preview updates, and execute create / update / backup /
restore / clone / change-address / remove / outbound-mail changes — with
every action journaled and visible as a **live log** in the GUI.

The console uses the same **admin-shell layout** as the SelfHelp CMS admin
UI: your **instances live in the left sidebar** (with live status dots and
their domain/port), the **center** shows the dashboard or the selected
instance's workspace, and the header carries the signed-in operator and the
**Sign out** action. Environment checks (Docker, internet, registry,
resources) **run automatically** when the dashboard loads — nothing stays
"Pending" waiting for a click, and any check can be re-run on demand.

There is no separate "bootstrap" UI anymore: a fresh state folder starts the
same console, asks you to **create the first operator account** in the
browser (localhost-only), and then opens the guided **create-instance
wizard** automatically because no instances exist yet. The first install
also initializes the server (shared proxy + inventory) as part of the same
flow.

## Security model (read this first)

- The BFF binds to **`127.0.0.1`** only. Do **not** expose it to the internet —
  reach it over an **SSH tunnel**:

```bash
ssh -L 8765:127.0.0.1:8765 you@your-server
# then open http://127.0.0.1:8765
```

- Every API call requires an authenticated **operator session**; all
  state-changing requests carry a CSRF token. Create operators with
  `sh-manager admin create` (see [security hardening](security-hardening.md)).
- Long-running actions run through a file-backed **operation journal**
  (`<root>/manager/operations/<opId>.json`) with **redacted** log lines —
  secrets and passwords never enter the journal.
- Every action is appended to the **audit log** (`<root>/manager/audit.jsonl`):
  operator, action, instance id, operation id, result.
- A **per-instance lock** (`<root>/manager/locks/`) allows one mutating
  operation per instance at a time. A second attempt returns
  `409 Conflict` — wait for the running operation to finish.
- Destructive actions (restore, full delete) require a **typed confirmation**
  in the dialog; a full delete never has a bare one-click path.

## Start the management UI

```bash
# on the server (or via the shm wrapper: ./shm.sh up   — background
#                                        ./shm.sh web  — foreground)
sh-manager web
# SelfHelp Manager console (vX.Y.Z): http://127.0.0.1:8765
```

**First run:** no operator accounts exist yet — the browser shows a one-time
**"Create the operator account"** screen (only reachable from localhost and
only while zero operators exist). Pick the e-mail + password there; you are
signed in immediately afterwards. The same account can also be created from
the CLI instead:

```bash
sh-manager admin create --email you@example.org --roles server_owner
# Created operator you@example.org [server_owner].
# Generated password (shown once, store it now): <generated>
```

Omitting `--password` generates a strong password and prints it exactly once
(same convention as the install's admin password). Every later start goes
straight to the sign-in page. The console shows the environment checks,
manager version + self-update status, and the **Instances** section.

## What each page does

- **Dashboard** — environment status (auto-run checks), the instance
  inventory table, the manager's own version + self-update status, and the
  CLI-only diagnostics. The overview metrics show active/broken instance
  counts at a glance.
- **Sidebar** — every instance with a live status dot (`active` /
  `disabled` / `broken`, plus "operation running"); click one to open its
  workspace in the center. The list reflects the **inventory/manifest state
  only** — it does not poll containers, so it stays instant with many
  instances. A `broken` instance (for example a missing manifest) shows the
  reason instead of crashing — repair it with
  `sh-manager instance repair <id>` (see
  [safe mode & recovery](safe-mode-and-recovery.md)).
- **Instance workspace** — manifest summary, the **backups list** (id, date,
  size, versions metadata), the operation history, and a **Run health
  check** button (backend + frontend + per-service container checks). Health
  is checked on demand when you click the button; nothing polls the
  containers in the background.
- **Create (step wizard)** — the **New instance** button opens a guided
  full-page wizard; it also opens **automatically** when the server has no
  instances yet. Steps: **Welcome** → **Preflight** (Docker, internet,
  registry, resources — auto-run, re-runnable) → **Basics** (name, id, admin
  account, optional **outbound-mail SMTP DSN**) → **Address** (production
  domain or local port; the **first** production install also asks for the
  Let's Encrypt e-mail used to bootstrap the shared proxy) → **Release**
  (version picked from the **verified registry dropdown** — never typed by
  hand) → **Review & install**. The install then shows a **live step
  checklist** (resolve & verify release → generate configuration & secrets →
  pull images & start services → wait for the database → run migrations →
  create the first admin → install plugins → warm caches → health checks)
  driven by the real journaled operation phase, with the **full journaled
  log streaming underneath**; when it finishes you can open the new instance
  directly. The generated admin password is **never shown in the browser**
  and never enters the journal log or state files: provisioning writes it to
  a restricted `0600` file on the server
  (`<root>/instances/<id>/secrets/admin_password`) and the operation result
  shows that file's path. Read it over SSH once, then remove it:

  ```bash
  ssh you@server
  cat /opt/selfhelp/instances/<id>/secrets/admin_password   # path shown in the operation result
  rm /opt/selfhelp/instances/<id>/secrets/admin_password    # optional, after the first login
  ```
- **Update** — always runs a **dry-run first** (resolved plan + preflight:
  ok / warning / blocked, with reasons). The target version comes from the
  **registry dropdown** ("latest" or a pinned release). Executing asks for
  explicit confirmation flags when the plan carries migration risk.
- **Backups** — create a backup, or restore one. A restore **always takes an
  automatic pre-restore backup first**, so the pre-restore state stays
  recoverable. The backup file stays on the server (the GUI shows the path;
  there is no browser download). Each backup carries an **origin badge**
  (manual / scheduled / pre-update / pre-restore), and the **schedule card**
  manages the automatic nightly backup: enable toggle, time, GFS retention
  slots, last/next run with the last result, current total size and the
  projected steady-state footprint — see
  [scheduled backups](scheduled-backups.md). While the console is running,
  its scheduler loop takes due backups automatically.
- **Clone** — copy an instance to a new id. The target address follows the
  source's mode: **production sources get a new domain, local sources get a
  new localhost port**. Clones always get **fresh secrets**; credentials are
  never copied.
- **Change address** — move a production instance to a **new domain** or a
  local instance to a **new port**, directly from the manager; the instance
  restarts automatically to apply it. See
  [Domains, DNS and local ports](domains-and-ports.md) for the DNS
  checklist and the CLI equivalent (`sh-manager instance set-address`).
- **Outbound e-mail (Email… button)** — view or change the instance's SMTP
  configuration (`MAILER_DSN`). Set a real SMTP relay
  (`smtp://user:pass@mail.example.org:587`) or clear the override to fall
  back to the bundled Mailpit; the instance restarts to apply it.
  Credentials are **redacted** everywhere the DSN is displayed. CLI
  equivalent: `sh-manager instance mailer <id> [--set <dsn>|--clear]`.
- **Remove** — three modes, same as the CLI: `disable` (reversible),
  `remove_containers_keep_data`, and `full_delete` (requires typing
  `delete <id>`).
- **Operation log viewer** — every action (including CMS-requested updates
  drained in the background) appears in the operation history; clicking an
  operation streams its journaled log lines live until it reaches a terminal
  state.

## CMS-requested updates and plugin operations drain automatically

While the persistent UI is running, a background poller drains pending
CMS-requested operations for **all** inventory instances (default every 15
seconds, configurable via `SHM_CMS_POLL_SECONDS`; `0` disables). Each drain
run is journaled, so a CMS-triggered update shows up in the GUI operation
history like any other action. The poller shares the per-instance locks with
GUI actions, so a manual update and the CMS loop can never run concurrently
on the same instance.

The same poller finalizes **in-CMS plugin installs/updates/uninstalls**: the
CMS verifies and stages the plugin (managed install mode), and the manager
runs the composer step, finalizes the operation, and propagates the plugin
state to the worker and scheduler containers — installing a plugin from the
CMS admin UI completes end-to-end within a poll tick, no shell required.

A second background loop runs **scheduled backups**: instances with an enabled
backup schedule get their nightly backup + retention pruning while the console
is up (`SHM_BACKUP_SCHEDULER=0` disables the loop; it shares the same
per-instance locks, so it never overlaps another operation). See
[scheduled backups](scheduled-backups.md).

Headless servers without a resident GUI keep using the systemd/cron triggers
— see [update.md](update.md), [scheduled backups](scheduled-backups.md) and
[`deploy/`](../../deploy/README.md).

## API reference

All endpoints require a session (exceptions noted); non-GET requests require
the CSRF header. Long-running actions return `202 { operationId }` — poll
the operation.

| Endpoint | Action |
| --- | --- |
| `POST /api/setup/operator` | One-time first-operator creation (localhost-only; rejected once any operator exists). |
| `GET /api/server/status` | Server initialized? instance count, manager version. |
| `POST /api/server/preflight` | Run the environment checks (Docker, internet, registry, resources). |
| `GET /api/instances` | List instances (inventory + manifest + status). |
| `POST /api/instances` | Create + provision an instance (first install also initializes the server). |
| `GET /api/instances/:id` | Instance detail. |
| `POST /api/instances/:id/health` | Run a health check (synchronous). |
| `GET /api/instances/:id/backups` | List backups (with origin). |
| `POST /api/instances/:id/backups` | Create a backup. |
| `POST /api/instances/:id/backups/:backupId/restore` | Pre-restore backup, then restore. |
| `GET /api/instances/:id/backup-schedule` | Schedule policy + last/next run + disk footprint. |
| `PUT /api/instances/:id/backup-schedule` | Update the schedule policy (validated server-side). |
| `POST /api/instances/:id/update/dry-run` | Resolve plan + preflight (synchronous). |
| `POST /api/instances/:id/update` | Execute an update. |
| `POST /api/instances/:id/clone` | Clone to a new instance (domain for production sources, port for local ones). |
| `POST /api/instances/:id/address` | Change the routed domain / local port; restarts the instance. |
| `GET /api/instances/:id/mailer` | Show the outbound-mail (SMTP) configuration (credentials redacted). |
| `POST /api/instances/:id/mailer` | Set or clear the SMTP DSN; restarts the instance. |
| `POST /api/instances/:id/remove` | Disable / remove / full-delete. |
| `GET /api/operations?instanceId=` | Operation history. |
| `GET /api/operations/:id` | One operation incl. journaled log lines. |
| `GET /api/registry/versions?channel=` | Installable versions for the version dropdowns. |

## See also

- [Install](install.md) — first install (GUI wizard and CLI).
- [Update](update.md) — update plans, rollback, CMS-requested updates.
- [Domains, DNS and local ports](domains-and-ports.md) — DNS setup and
  changing an instance's address (GUI + CLI).
- [Backup & restore](backup-restore.md) · [Clone & remove](clone-remove.md) —
  the CLI equivalents of the GUI actions.
- [Security hardening](security-hardening.md) — operators, roles, tokens.
