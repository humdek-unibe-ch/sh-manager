# Quick reference (command cheat-sheet)

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.4`)
Last verified: 2026-06-10
Source of truth: `apps/cli/src/bin.ts`

The commands you reach for most. `<root>` is the SelfHelp root (default
`/opt/selfhelp`); add `--root <dir>` to any command to override it. Replace
`website1` with your instance id.

Lifecycle-changing actions (install, update, remove, restore, clone, safe-mode)
go through `sh-manager` so the inventory, manifest, and lock stay correct. Plain
`docker compose` is fine for read-only inspection and a transient restart, but
never for editing an instance's stack.

## Check status / health

| Task | Command |
| --- | --- |
| List instances + status | `sh-manager instance list` |
| Instance health (backend + frontend) | `sh-manager instance health website1` |
| Host resources / ports / Docker | `sh-manager doctor` |
| Public readiness probe (via BFF) | `curl -fsS https://website1.example.ch/health` |
| In-CMS system view | open `/admin/system` in the CMS admin UI |

## View logs / containers / restart

Run against the instance's compose file (`<root>/instances/website1/compose.yaml`):

| Task | Command |
| --- | --- |
| Show containers | `docker compose -f <root>/instances/website1/compose.yaml ps` |
| Tail all logs | `docker compose -f <root>/instances/website1/compose.yaml logs -f --tail=200` |
| Logs for one service | `docker compose -f <root>/instances/website1/compose.yaml logs -f backend` |
| Restart one service | `docker compose -f <root>/instances/website1/compose.yaml restart backend` |
| Run a backend console cmd | `docker compose -f <root>/instances/website1/compose.yaml exec backend php bin/console <cmd>` |

Services: `frontend`, `backend`, `worker`, `scheduler`, `mysql`, `redis`,
`mercure` (+ `mailpit` in local mode).

## Install / provision

| Task | Command |
| --- | --- |
| Host preflight | `sh-manager doctor` |
| Bootstrap server (once) | `sh-manager server init --server-id srv-001 --mode production --email ops@example.ch` |
| Bootstrap for local testing | `sh-manager server init --server-id dev --mode local` |
| Install + provision | `sh-manager instance install --id website1 --domain website1.example.ch --registry <url> --version latest --provision --admin-email ops@example.ch` |
| Install local (port, no SSL) | `sh-manager instance install --id demo1 --mode local --port 8080 --registry <url> --version latest --provision --admin-email you@example.test` |
| Web wizard (localhost BFF) | `sh-manager web` (alias: `sh-manager-web --root /opt/selfhelp`) |

## Update

| Task | Command |
| --- | --- |
| Dry-run (plan + preflight) | `sh-manager instance update website1 --dry-run` |
| Apply (backup-first, auto-rollback) | `sh-manager instance update website1` |
| Target a version | `sh-manager instance update website1 --version 0.1.1` |
| Accept destructive migration | `sh-manager instance update website1 --accept-migration-risk` |
| Process a CMS-requested update | `sh-manager instance process-operations website1 --backend-url http://127.0.0.1:PORT --token "$SELFHELP_MANAGER_TOKEN"` |
| Is a newer manager released? | `sh-manager self-update` (exit `2` = update available; prints the update commands) |

## Back up / restore / clone

| Task | Command |
| --- | --- |
| Backup | `sh-manager instance backup website1` |
| Second backup same day | `sh-manager instance backup website1 --seq 2` |
| Validate + plan a restore | `sh-manager instance restore website1 <backupId>` |
| Restore in place | `sh-manager instance restore website1 <backupId> --apply` |
| Restore as a clone | `sh-manager instance restore website1 <backupId> --mode restore_as_clone --new-domain copy.example.ch --apply` |
| Clone a live instance | `sh-manager instance clone website1 website1-staging --domain staging.example.ch --apply` |

## Recover

| Task | Command |
| --- | --- |
| Enable plugin-free safe mode | `sh-manager instance safe-mode enable website1` |
| Disable safe mode | `sh-manager instance safe-mode disable website1` |
| Redacted support bundle | `sh-manager instance support-bundle website1` |

## Remove (deliberate)

| Task | Command |
| --- | --- |
| Disable (reversible) | `sh-manager instance remove website1 --mode disable` |
| Remove containers, keep data | `sh-manager instance remove website1 --mode remove_containers_keep_data` |
| Full delete (keeps volumes/backups) | `sh-manager instance remove website1 --mode full_delete --confirm "delete website1"` |
| Full delete + wipe data | `sh-manager instance remove website1 --mode full_delete --delete-volumes --delete-backups --confirm "delete website1"` |

## Operators (persistent web UI)

| Task | Command |
| --- | --- |
| First-run bootstrap token | `sh-manager admin bootstrap-token --ttl 3600` |
| Create operator | `sh-manager admin create --email ops@example.ch --roles server_owner --name "Ops"` |
| Grant a role | `sh-manager admin role grant ops@example.ch instance_operator` |
| Allow OIDC email | `sh-manager admin allow-email ops@example.ch` |
| List / disable | `sh-manager admin list` · `sh-manager admin disable old@example.ch` |

## Paths and env vars

| Path | What |
| --- | --- |
| `<root>/selfhelp.server.json` | Server inventory. |
| `<root>/proxy/compose.yaml` | Shared Traefik proxy. |
| `<root>/instances/<id>/compose.yaml` | Instance stack. |
| `<root>/instances/<id>/manifest.json` · `lock.json` | What's installed · pinned digests. |
| `<root>/instances/<id>/README.md` | Per-instance operator commands. |
| `<root>/instances/<id>/backups/` | Checksummed backups. |
| `<root>/manager/operators.json` | Operator store (persistent mode). |

| Env var | Purpose |
| --- | --- |
| `SELFHELP_ROOT` | Root directory (default `/opt/selfhelp`). |
| `SELFHELP_TRUSTED_KEYS` | Registry trusted-keys file (default: the pinned official prod key shipped with the manager). |
| `SELFHELP_MANAGER_TOKEN` | Per-instance token for `process-operations`. |
| `SELFHELP_PUBLIC_IP` | Enables a hard server-IP DNS comparison. |
| `SHM_WEB_HOST` / `SHM_WEB_PORT` | Web BFF bind host/port (default `127.0.0.1:8765`). |
| `SELFHELP_LOCALHOST_PROBE_HOST` | Host substituted for `localhost` in health probes when the manager runs in a container (auto: `host.docker.internal`; `off` disables). |

## See also

- [Operations runbook](operations-runbook.md) — the end-to-end walkthrough.
- [Troubleshooting](troubleshooting.md) — when a command fails.
