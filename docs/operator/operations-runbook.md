# Operations runbook (end to end)

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`, manages the SelfHelp 0.x pre-release platform line)
Last verified: 2026-06-09
Source of truth: `apps/cli/src/bin.ts`, `apps/cli/src/actions.ts`, `apps/web/src/bin.ts`

This is the **single walkthrough** of the whole instance lifecycle, from an empty
server to day-to-day operation, updates, backups, and recovery. Each phase is a
short summary plus the commands you actually run; the deep detail lives in the
task runbook linked at the end of the phase.

If you just want a command, jump to the [quick reference](quick-reference.md).
If something is broken, jump to [troubleshooting](troubleshooting.md).

## The lifecycle

```text
 install ──▶ configure ──▶ operate ──▶ update ──▶ back up
   │            (once)       (daily)   (as needed) (scheduled)
   │                                                   │
   └──────────────── recover / troubleshoot ◀──────────┘
```

The hard rules that hold across every phase:

- `sh-manager` is the **only** tool that talks to Docker. The CMS records
  instance-scoped requests; it never drives Docker itself.
- Releases are **signed** and pulled from the **one** official registry. Nothing
  is compiled on the server.
- Instance data (database, uploads, plugin artifacts, secrets, backups) lives in
  Docker volumes that **survive** updates and removals unless you run an
  explicit, confirmed full delete.

Everywhere below, `<root>` is the SelfHelp root (default `/opt/selfhelp`,
override with `--root` or `SELFHELP_ROOT`) and `website1` is an example instance
id.

## Phase 1 — Install

Bootstrap the server once (shared Traefik proxy + inventory), then install and
fully provision the first instance.

```bash
# 1. host preflight (disk, memory, CPU, ports 80/443, Docker + Compose)
sh-manager doctor

# 2. bootstrap the server (once)
sh-manager server init --server-id srv-001 --mode production --email ops@example.ch

# 3. install + provision an instance (DB → migrate → admin → plugins → caches → health)
sh-manager instance install --id website1 --domain website1.example.ch \
  --registry https://humdek-unibe-ch.github.io/sh2-plugin-registry/ \
  --version latest --provision --admin-email ops@example.ch
```

The generated admin password is printed **once** and never stored — capture it
now. Prefer the **web wizard** for a guided first install.

→ Detail: [install](install.md).

## Phase 2 — Configure (immediately after install)

Do the post-install tasks before going live: store the admin password, switch
the web UI to authenticated persistent mode, create operators, schedule backups,
and (for CMS-driven updates) wire the per-instance operation processor.

→ Detail: [post-install checklist](post-install-checklist.md) and
[security hardening](security-hardening.md).

## Phase 3 — Operate (daily)

Day-to-day is mostly observation. Check health and look at logs; change config
only through the manager.

```bash
sh-manager instance list                 # what is installed + status
sh-manager instance health website1      # backend + frontend probes
sh-manager doctor                        # host resources / ports / Docker

# transient inspection / restart (read-only host access; not a config change)
docker compose -f <root>/instances/website1/docker-compose.yml ps
docker compose -f <root>/instances/website1/docker-compose.yml logs -f --tail=200
```

Admins also get an in-CMS view at **`/admin/system`** (version, aggregated
health, security advisories, maintenance/safe-mode state).

→ Detail: [quick reference](quick-reference.md).

## Phase 4 — Update

Always dry-run first; applying is backup-first and rolls back on failure.

```bash
sh-manager instance update website1 --dry-run     # plan + preflight, no changes
sh-manager instance update website1               # apply (auto backup + rollback)
sh-manager instance health website1               # verify
```

For CMS-requested updates, the manager claims the instance-scoped operation. A
single run **drains every pending operation** for the instance, then exits:

```bash
sh-manager instance process-operations website1 \
  --backend-url http://127.0.0.1:PORT --token "$SELFHELP_MANAGER_TOKEN"
```

### Scheduling the update-operations loop

A CMS-requested update only leaves `requested` once the manager processes it, so
the consumer must run on a schedule. Wire one of the supervised triggers shipped
in [`deploy/`](../../deploy/README.md):

- **systemd (recommended)** — `sh-manager-operations@<id>.service` runs
  `process-operations <id> --watch`, a resident loop (`Restart=always`) that
  drains every `--interval` seconds (default 15s).
- **cron** — one-shot drain every minute per instance for hosts without systemd.

Both read the per-instance token + backend URL from a `0600` env file so secrets
never appear in the unit, crontab, or process list. The manager token is
per-instance, and server-side scope checks reject cross-instance operations.

→ Detail: [update](update.md).

## Phase 5 — Back up

Take a backup before every risky operation, and run scheduled backups stored
off-box.

```bash
sh-manager instance backup website1                       # checksummed backup
sh-manager instance restore website1 <backupId>           # validate + show plan
sh-manager instance restore website1 <backupId> --apply   # restore in place
```

→ Detail: [backup & restore](backup-restore.md). Copying a live instance is in
[clone & remove](clone-remove.md).

## Phase 6 — Recover / troubleshoot

When an instance misbehaves: stabilise (safe mode if a plugin is suspect),
diagnose (`doctor`, `instance health`, support bundle), then roll back or
restore.

```bash
sh-manager instance safe-mode enable website1    # boot with no plugins
sh-manager instance support-bundle website1      # redacted diagnostics to share
sh-manager instance safe-mode disable website1   # back to normal once healthy
```

→ Detail: [troubleshooting](troubleshooting.md) and
[safe mode & recovery](safe-mode-and-recovery.md).

## Decommission

Retiring an instance is a separate, deliberate action — `disable` (reversible),
`remove_containers_keep_data` (reversible), or a confirmed `full_delete`.

→ Detail: [clone & remove](clone-remove.md).

## See also

- [Quick reference](quick-reference.md) — the command cheat-sheet.
- [Troubleshooting](troubleshooting.md) — symptom → cause → fix.
- [Post-install checklist](post-install-checklist.md) — what to do right after install.
- [Security hardening](security-hardening.md) — the production posture.
