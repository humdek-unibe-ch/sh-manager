# Manage instances from the GUI

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`, persistent web mode)
Last verified: 2026-06-12
Source of truth: `apps/web/src/server.ts`, `apps/web/src/instances.ts`, `apps/web/src/jobs.ts`, `apps/web/src/poller.ts`, `apps/web/src/ui/features/manager/`

The persistent-mode web UI manages the full instance lifecycle from the
browser: list and inspect instances, run health checks, browse backups,
preview updates, and execute create / update / backup / restore / clone /
remove — with every action journaled and visible as a **live log** in the GUI.

The bootstrap wizard and the operations console are the same server in two
modes. **Bootstrap mode** (fresh state folder) only installs and self-locks;
it never exposes instance management. Everything on this page requires
**persistent mode**.

**Mode is auto-detected**: `sh-manager web` starts in persistent mode as soon
as the server is initialized (`<root>/selfhelp.server.json` exists — i.e.
after the first install), and in bootstrap mode on a fresh state folder. An
explicit `--mode bootstrap|persistent` (or `SHM_WEB_MODE`) always overrides
the detection.

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
# on the server (or via the shm wrapper: ./shm.sh web)
sh-manager web
# SelfHelp Manager persistent UI (vX.Y.Z): http://127.0.0.1:8765
# Mode auto-selected: persistent (server inventory found) — sign in to manage instances.
```

On an initialized server this starts the management console directly (no
flags needed). `--mode persistent --persist` still works and forces the same
mode explicitly.

Sign in with an operator account. **First run:** no operator accounts exist
yet — the sign-in page tells you so and shows the command to create one:

```bash
sh-manager admin create --email you@example.org --roles server_owner
# Created operator you@example.org [server_owner].
# Generated password (shown once, store it now): <generated>
```

Omitting `--password` generates a strong password and prints it exactly once
(same convention as the install's admin password). Then reload the sign-in
page and log in. The console shows the environment checks, manager version +
self-update status, and the **Instances** section.

## What each page does

- **Instances list** — every instance from the server inventory with its
  status badge (`active` / `disabled` / `broken`), mode, domain/port, and
  installed version. The list reflects the **inventory/manifest state only**
  — it does not poll containers, so it stays instant with many instances.
  Live container/health state is checked **on demand** from the instance
  detail page. A `broken` instance (for example a missing manifest) shows
  the reason instead of crashing — repair it with
  `sh-manager instance repair <id>` (see
  [safe mode & recovery](safe-mode-and-recovery.md)).
- **Instance detail** — manifest summary, the **backups list** (id, date,
  size, versions metadata), the operation history, and a **Run health
  check** button (backend + frontend + per-service container checks). Health
  is checked on demand when you click the button; nothing polls the
  containers in the background.
- **Update** — always runs a **dry-run first** (resolved plan + preflight:
  ok / warning / blocked, with reasons). Executing asks for explicit
  confirmation flags when the plan carries migration risk.
- **Backups** — create a backup, or restore one. A restore **always takes an
  automatic pre-restore backup first**, so the pre-restore state stays
  recoverable. The backup file stays on the server (the GUI shows the path;
  there is no browser download).
- **Clone** — copy an instance to a new id + domain/port. Clones always get
  **fresh secrets**; credentials are never copied.
- **Create** — the same plan/install path as the wizard. The generated admin
  password is **never shown in the browser** and never enters the journal log
  or state files: provisioning writes it to a restricted `0600` file on the
  server (`<root>/instances/<id>/secrets/admin_password`) and the operation
  result shows that file's path. Read it over SSH once, then remove it:

  ```bash
  ssh you@server
  cat /opt/selfhelp/instances/<id>/secrets/admin_password   # path shown in the operation result
  rm /opt/selfhelp/instances/<id>/secrets/admin_password    # optional, after the first login
  ```
- **Remove** — three modes, same as the CLI: `disable` (reversible),
  `remove_containers_keep_data`, and `full_delete` (requires typing
  `delete <id>`).
- **Operation log viewer** — every action (including CMS-requested updates
  drained in the background) appears in the operation history; clicking an
  operation streams its journaled log lines live until it reaches a terminal
  state.

## CMS-requested updates drain automatically

While the persistent UI is running, a background poller drains pending
CMS-requested operations for **all** inventory instances (default every 15
seconds, configurable via `SHM_CMS_POLL_SECONDS`; `0` disables). Each drain
run is journaled, so a CMS-triggered update shows up in the GUI operation
history like any other action. The poller shares the per-instance locks with
GUI actions, so a manual update and the CMS loop can never run concurrently
on the same instance.

Headless servers without a resident GUI keep using the systemd/cron triggers
— see [update.md](update.md) and [`deploy/`](../../deploy/README.md).

## API reference (persistent mode only)

All endpoints require a session; non-GET requests require the CSRF header.
Long-running actions return `202 { operationId }` — poll the operation.

| Endpoint | Action |
| --- | --- |
| `GET /api/instances` | List instances (inventory + manifest + status). |
| `POST /api/instances` | Create + provision an instance. |
| `GET /api/instances/:id` | Instance detail. |
| `POST /api/instances/:id/health` | Run a health check (synchronous). |
| `GET /api/instances/:id/backups` | List backups. |
| `POST /api/instances/:id/backups` | Create a backup. |
| `POST /api/instances/:id/backups/:backupId/restore` | Pre-restore backup, then restore. |
| `POST /api/instances/:id/update/dry-run` | Resolve plan + preflight (synchronous). |
| `POST /api/instances/:id/update` | Execute an update. |
| `POST /api/instances/:id/clone` | Clone to a new instance. |
| `POST /api/instances/:id/remove` | Disable / remove / full-delete. |
| `GET /api/operations?instanceId=` | Operation history. |
| `GET /api/operations/:id` | One operation incl. journaled log lines. |

## See also

- [Install](install.md) — bootstrap wizard and CLI install.
- [Update](update.md) — update plans, rollback, CMS-requested updates.
- [Backup & restore](backup-restore.md) · [Clone & remove](clone-remove.md) —
  the CLI equivalents of the GUI actions.
- [Security hardening](security-hardening.md) — operators, roles, tokens.
