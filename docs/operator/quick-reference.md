# Quick reference (command cheat-sheet)

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`)
Last verified: 2026-06-12
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
| Install + provision | `sh-manager instance install --id website1 --domain website1.example.ch --version latest --provision --admin-email ops@example.ch` |
| Install local (port, no SSL) | `sh-manager instance install --id demo1 --mode local --port 8080 --version latest --provision --admin-email you@example.test` |
| Use a dev/test registry | add `--registry <url>` (default: the official registry) |
| Install with a real SMTP relay | add `--mailer-dsn smtp://user:pass@mail.example.org:587` |
| Web UI (localhost BFF) | `sh-manager web` (alias: `sh-manager-web --root /opt/selfhelp`; wrapper: `./shm.sh up`) |
| Generate the `shm` wrapper script | `sh-manager wrapper --shell powershell\|bash > shm.ps1` (save into the state folder) |
| Server initialized? | `sh-manager server status` |

## Outbound mail (SMTP)

| Task | Command |
| --- | --- |
| Show the instance mailer config | `sh-manager instance mailer website1` (credentials redacted) |
| Set an SMTP relay | `sh-manager instance mailer website1 --set smtp://user:pass@mail.example.org:587` |
| Back to the default (bundled Mailpit) | `sh-manager instance mailer website1 --clear` |
| Write only, apply later | add `--no-restart` |

## Environment variables (non-secret `.env`)

| Task | Command |
| --- | --- |
| Show the effective environment | `sh-manager instance env website1` (managed/secret keys flagged read-only) |
| Override an editable value | `sh-manager instance env website1 --set JWT_TOKEN_TTL=7200` |
| Add a custom variable | `sh-manager instance env website1 --set MY_FLAG=on` |
| Remove an override (back to default) | `sh-manager instance env website1 --unset JWT_TOKEN_TTL` |
| Write only, apply later | add `--no-restart` |

> Manager-owned keys (instance id, internal URLs, JWT key paths, plugin trust)
> and `MAILER_DSN` are protected. Use `instance mailer` for SMTP credentials —
> they go into the restricted `secrets.env`, never the plain `.env`.

## Update

| Task | Command |
| --- | --- |
| Dry-run (plan + preflight) | `sh-manager instance update website1 --dry-run` |
| Apply (backup-first, auto-rollback) | `sh-manager instance update website1` |
| Target a version | `sh-manager instance update website1 --version 0.1.1` |
| Accept destructive migration | `sh-manager instance update website1 --accept-migration-risk` |
| Frontend-only dry-run | `sh-manager instance update-frontend website1 --dry-run` |
| Frontend-only apply | `sh-manager instance update-frontend website1` |
| Frontend-only target a version | `sh-manager instance update-frontend website1 --version 0.1.7` |
| Process a CMS-requested update | `sh-manager instance process-operations website1` (execs into the backend container; `--backend-url`/`--token` only for remote setups) |
| Update the manager itself | `sh-manager self-update` (pulls the new image + restarts the web GUI container; source: git pull + build) — wrapper: `./shm.sh update` |
| Only check for a manager update | `sh-manager self-update --check` (exit `2` = update available) |
| Stop / start / reinstall the manager GUI | `./shm.sh down` · `./shm.sh up` · `./shm.sh reinstall` (instances keep running; state survives) |

## Back up / restore / clone

| Task | Command |
| --- | --- |
| Backup | `sh-manager instance backup website1` |
| Second backup same day | `sh-manager instance backup website1` (sequence auto-increments) |
| Nightly schedule on/off | `sh-manager instance backup-schedule website1 --enable --time 02:00` · `--disable` |
| Show schedule + footprint | `sh-manager instance backup-schedule website1` |
| Preview / apply retention | `sh-manager instance backup-prune website1 --dry-run` · without `--dry-run` |
| Run due scheduled backups now | `sh-manager server run-scheduled-backups` |
| Validate + plan a restore | `sh-manager instance restore website1 <backupId>` |
| Restore in place | `sh-manager instance restore website1 <backupId> --apply` |
| Restore as a clone | `sh-manager instance restore website1 <backupId> --mode restore_as_clone --new-domain copy.example.ch --apply` |
| Clone a live instance (production source) | `sh-manager instance clone website1 website1-staging --domain staging.example.ch --apply` |
| Clone a live instance (local source) | `sh-manager instance clone localtest localtest-copy --target-local-port 9124 --apply` |

## Change address (domain / port)

| Task | Command |
| --- | --- |
| Move a production instance to a new domain | `sh-manager instance set-address website1 --domain new.example.ch` |
| Move a local instance to a new port | `sh-manager instance set-address localtest --port 9200` |
| Write the config only (apply later) | `sh-manager instance set-address website1 --domain new.example.ch --no-restart` |
| Hard-fail when DNS does not point here | `sh-manager instance set-address website1 --domain new.example.ch --strict-dns` |

## Recover

| Task | Command |
| --- | --- |
| Enable plugin-free safe mode | `sh-manager instance safe-mode enable website1` |
| Disable safe mode | `sh-manager instance safe-mode disable website1` |
| Repair a broken instance (missing manifest) | `sh-manager instance repair website1` |
| Redacted support bundle | `sh-manager instance support-bundle website1` |

## Remove (deliberate)

| Task | Command |
| --- | --- |
| Disable (reversible) | `sh-manager instance remove website1 --mode disable` |
| Remove containers, keep data | `sh-manager instance remove website1 --mode remove_containers_keep_data` |
| Full delete (keeps volumes/backups) | `sh-manager instance remove website1 --mode full_delete --confirm "delete website1"` |
| Full delete + wipe data | `sh-manager instance remove website1 --mode full_delete --delete-volumes --delete-backups --confirm "delete website1"` |
| **Full server purge** (every instance + proxy + state; keeps backups) | `sh-manager server purge --confirm "purge selfhelp"` |
| Full server purge incl. backups | `sh-manager server purge --confirm "purge selfhelp" --delete-backups` |

## Operators (web UI)

The web console manages the full instance lifecycle from the browser
(list, health, backups, update dry-run + execute, restore, clone, change
address, outbound mail, remove, live operation logs) — see
[GUI instance management](gui-instance-management.md).

| Task | Command |
| --- | --- |
| Start the management UI | `sh-manager web` (reach it via SSH tunnel; first run offers in-browser operator creation) |
| Create operator | `sh-manager admin create --email ops@example.ch --roles server_owner --name "Ops"` (no `--password` = generated + shown once) |
| Grant a role | `sh-manager admin role grant ops@example.ch instance_operator` |
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
| `<root>/manager/operators.json` | Operator store (web UI sign-in). |

| Env var | Purpose |
| --- | --- |
| `SELFHELP_ROOT` | Root directory (default `/opt/selfhelp`). |
| `SELFHELP_TRUSTED_KEYS` | Registry trusted-keys file (default: the pinned official prod key shipped with the manager). |
| `SELFHELP_MANAGER_TOKEN` | Per-instance token for `process-operations` (generated at install, injected via the instance's secrets env). |
| `SHM_CMS_POLL_SECONDS` | CMS-operations drain interval of the persistent web UI (default `15`, `0` disables). |
| `SELFHELP_PUBLIC_IP` | Enables a hard server-IP DNS comparison. |
| `SHM_WEB_HOST` / `SHM_WEB_PORT` | Web BFF bind host/port (default `127.0.0.1:8765`). |
| `SELFHELP_LOCALHOST_PROBE_HOST` | Host substituted for `localhost` in health probes when the manager runs in a container (auto: `host.docker.internal`; `off` disables). |
| `SELFHELP_ENGINE_ROOT` | The engine's view of the state root when it differs from the container's (auto-discovered by self-inspection; `off` disables translation). |

## See also

- [Operations runbook](operations-runbook.md) — the end-to-end walkthrough.
- [Troubleshooting](troubleshooting.md) — when a command fails.
