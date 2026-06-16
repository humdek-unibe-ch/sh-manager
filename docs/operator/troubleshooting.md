# Troubleshooting

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`, manages the SelfHelp 0.x pre-release platform line)
Last verified: 2026-06-12
Source of truth: `apps/cli/src/actions.ts`, `packages/core/src`, `packages/docker/src`, backend `src/EventListener`, `docker/Dockerfile`

Symptom-first triage. Start with the two diagnostics that cover most cases, then
jump to the matching section. For a plugin-broke-the-CMS situation go straight to
[safe mode & recovery](safe-mode-and-recovery.md); to hand a problem to support,
collect a [support bundle](support-bundle.md).

```bash
sh-manager doctor                      # host: disk, memory, CPU, ports 80/443, Docker + Compose
sh-manager instance health website1    # instance: backend + frontend probes
docker compose -f <root>/instances/website1/compose.yaml ps   # container states
```

`<root>` defaults to `/opt/selfhelp`. Replace `website1` with your instance id.

## An instance won't start / is unhealthy

1. **See which container is down or restarting:**

```bash
docker compose -f <root>/instances/website1/compose.yaml ps
docker compose -f <root>/instances/website1/compose.yaml logs --tail=200 backend
```

2. **Common causes by service:**

| Symptom in logs | Likely cause | Fix |
| --- | --- | --- |
| `mkdir /data/caddy/pki: permission denied` (backend/frontend) | Old image booted as non-root without writable `/data` `/config` | Update to a current image (`sh-manager instance update`); the backend image pre-creates these as `www-data`. |
| `Unable to read the "/app/.env" environment file` (backend/worker/scheduler, install stops at `wait_db`) | Core images up to 0.1.2 bake no `/app/.env`, which Symfony requires on every boot | Fixed in manager >= 1.0.10: the instance compose bind-mounts the instance `.env` at `/app/.env`. Update the manager image and reinstall/re-run the install — it resumes where it stopped. |
| `SQLSTATE[HY000] [1045] Access denied for user 'selfhelp'@...` (install stops at `wait_db`) | The instance's `mysql_data` volume was initialised by an **earlier** install attempt with different generated secrets (MySQL only applies `MYSQL_USER`/`MYSQL_PASSWORD` the first time an empty volume initialises). Typical with a manager < 1.0.10 that regenerated secrets on retry, or after deleting the instance folder while keeping its volumes. | Retrying can never succeed; the manager (>= 1.0.11) detects this and stops after a few attempts with this remediation: remove the instance **including volumes** and reinstall — `sh-manager instance remove <id> --mode full_delete --delete-volumes --confirm "delete <id>"` — or restore the original `secrets/secrets.env` if you still have it. Manager >= 1.0.10 reuses on-disk secrets on retry, so fresh installs no longer get into this state. |
| `1419 ... SUPER privilege and binary logging is enabled` during migrate | MySQL won't let the app user create stored routines | Current installs start MySQL with `--log-bin-trust-function-creators=1`; update the instance so its compose includes it, then re-run provisioning/migrate. |
| `table already exists` / `1050` on first boot | The worker created `messenger_messages` before migrations (fresh-provision race) | Harmless on current builds (idempotent create); re-run `instance install --provision` or the migrate step. |
| `mysql` unhealthy / connection refused | DB still starting, or volume problem | Wait for the healthcheck; check `logs mysql`; ensure the `mysql_data` volume exists. |
| backend up but `health` degraded | A dependency (Redis/Mercure/mailer) is down or not configured | See [Health reports a degraded component](#health-reports-a-degraded-component). |
| `volume-init` shows `Exited (0)` / `Completed` | **Not a fault.** It is a one-shot init container that chowns the data volumes for the Symfony user and then exits; the long-running services gate on its success. The manager's own health verdict ignores it. | Nothing to do — leave it. It re-runs (idempotently) on every `compose up`. |

3. **If it started failing right after a change you made by hand**, restore the
   pre-change backup: `sh-manager instance restore website1 <backupId> --apply`
   (see [backup & restore](backup-restore.md)). A failed *update* already rolled
   back automatically.

## DNS does not resolve / wrong server

Production installs validate DNS. Symptoms: install warns or (with `--strict-dns`)
blocks; the site is unreachable or TLS never issues.

- Confirm the record points here: `dig +short website1.example.ch` should return
  this server's public IP.
- For a hard server-IP comparison, set `SELFHELP_PUBLIC_IP` so the manager
  compares against it instead of guessing.
- DNS still propagating? Install without `--strict-dns` (it warns instead of
  blocking), finish setup, and verify once DNS lands. Re-check with
  `sh-manager instance health website1`.

## TLS certificate not issued (HTTPS fails)

Certificates are issued by the shared Traefik proxy via Let's Encrypt.

- **The proxy must actually be running.** Check:
  `docker compose -f <root>/proxy/compose.yaml ps` — if it lists nothing, the
  proxy never started (e.g. a failed first bootstrap). Start it with
  `sh-manager server start` (`1.5.3+`), then re-check. An installed-but-down
  proxy is the usual cause of `backend fetch failed` / `frontend unreachable`.
- **Ports 80 and 443 must be free and reachable** from the internet — `sh-manager
  doctor` checks they are free locally; also confirm no upstream firewall blocks
  them. An existing Apache/nginx on 80/443 is the usual blocker — see
  [reverse proxy & Apache](reverse-proxy-and-apache.md).
- **DNS must resolve first** (see above) — Let's Encrypt validates over the
  domain.
- A bootstrap `--email` must have been provided to `server init` for production.
- Inspect the proxy logs without SSH: open the manager web console → **Server
  operations** → the **Reverse proxy (TLS & routing)** card → **View proxy logs**
  (filter by `acme` for certificate activity), or run `sh-manager server logs`
  (`1.5.5+`). The raw command is still
  `docker compose -f <root>/proxy/compose.yaml logs --tail=200`.
- Let's Encrypt rate-limits repeated failures; fix DNS/ports first, then retry
  rather than looping.

## Every domain returns "404 page not found" (proxy can't see containers)

The instances are healthy and correctly labelled, but every hostname (and the
ACME/TLS challenge) returns a Traefik `404 page not found`. This is the
**Docker Engine 29+ × old-Traefik** incompatibility:

- Docker Engine 29 raised the daemon's *minimum* API version to **1.44**.
  Traefik **before v3.6.1** hardcoded Docker API **1.24** in its Docker provider,
  so on Engine 29+ it fails every poll (`client version 1.24 is too old. Minimum
  supported API version is 1.44`), discovers **no containers**, has zero routers,
  and 404s everything.
- **Fix:** update the manager to **`1.5.5+`** (the shared proxy now pins
  `traefik:v3.7.5`, which auto-negotiates the Docker API), then recreate the
  proxy once: `sh-manager server start`. Verify with
  `sh-manager server logs` (or the GUI **View proxy logs**) — the "client version
  1.24 is too old" lines stop and routers appear.
- Setting `DOCKER_API_VERSION` does **not** help — Traefik ignores it; the image
  version is the fix.

## Ports 80/443 already in use (often Apache/nginx)

`sh-manager doctor` reports the port check as failed, and a production domain
does not load / has no TLS. The most common cause is an existing **Apache or
nginx** holding 80/443 — the shared SelfHelp Traefik proxy must own them.

- Find the holder: `sudo ss -ltnp 'sport = :80'` (and `:443`).
- If it is Apache/nginx and this host is dedicated to SelfHelp, disable it:
  `sudo systemctl disable --now apache2` (or `nginx`), then re-run `doctor`.
- If you must keep the other web server, you cannot share 80/443 — see the
  options in [reverse proxy & Apache](reverse-proxy-and-apache.md).
- After freeing the ports, start the shared proxy: `sh-manager server start`
  (`1.5.3+`), then verify with
  `docker compose -f <root>/proxy/compose.yaml ps`.

## Out of disk space

Backups, images, logs, and volumes accumulate. `sh-manager doctor` flags low disk.

- **See what's large:** `df -h` then `du -sh <root>/instances/*/backups` and
  `docker system df`.
- **Old backups:** copy them off-box, then prune old backup directories under
  `<root>/instances/<id>/backups/` (keep recent + off-box copies). Backups are
  plain directories; deleting an old one never touches live data.
- **Dangling images/build cache:** `docker image prune` / `docker builder prune`
  (safe — does not remove named volumes). **Do not** run `docker system prune
  --volumes`, which would target data volumes.
- Never delete `*_mysql_data`, `*_uploads`, `*_plugin_artifacts`, or
  `*_plugin_artifacts_public` volumes — that is live instance data.

## An update is blocked or failed

- **Blocked at preflight:** re-read the dry-run reasons
  (`sh-manager instance update website1 --dry-run`). Typical blocks: an
  incompatible plugin, an open security advisory, or a destructive migration.
  Resolve the named cause; destructive migrations require
  `--accept-migration-risk` *after* a verified backup.
- **Failed during apply:** it **rolls back automatically** and keeps the previous
  version running. Re-run the dry-run to see why, fix the cause, retry.
- **MySQL major-version upgrade required:** approve the one-way upgrade with
  `--approve-mysql-major` only after a verified backup. Detail:
  [update](update.md).

## The site returns 503 (maintenance) and won't clear

Maintenance mode makes normal `/cms-api` traffic return a clean 503 (the manager
sets it around updates; the readiness probe, auth, the manager loop, and
`admin.system.*` stay reachable).

- If an update is mid-flight, let it finish (or it rolls back and clears
  maintenance).
- If it's stuck on, clear it from the CMS admin **`/admin/system`** screen, or in
  the backend container:

```bash
docker compose -f <root>/instances/website1/compose.yaml \
  exec backend php bin/console selfhelp:maintenance --disable
```

- If `SELFHELP_MAINTENANCE_MODE` is set in the instance `.env`, the env switch
  wins — clear it there and restart the backend.

## CMS admin shows safe mode / plugins missing

Safe mode boots the backend with core bundles only (no plugins). It's the
recovery switch for a bad plugin.

```bash
sh-manager instance safe-mode disable website1   # re-enable plugins once healthy
```

If `SELFHELP_DISABLE_PLUGINS` is set in `.env`, that env switch forces safe mode
on regardless — clear it there. Detail: [safe mode & recovery](safe-mode-and-recovery.md).

## "Could not check advisories" in the CMS

The advisories card degrades to *unavailable* when the official registry can't be
reached. This **does not block** the instance.

- Confirm the server has outbound internet and can reach the registry URL.
- Retry once connectivity is restored; the card refreshes on next load.

## Health reports a degraded component

`/admin/system` and `sh-manager instance health` aggregate per-component status.
Components reported `not_configured` are optional and not failures.

| Component | If degraded |
| --- | --- |
| database | Check `mysql` container + healthcheck; see "won't start" above. |
| cache / redis | Check the `redis` container; confirm the instance points at it. |
| mercure | Realtime hub; `not_configured` is fine if you don't use realtime. |
| worker (messenger) | Check the `worker` container logs; it consumes `plugin_ops`. |
| scheduler | Check the `scheduler` container; it runs due jobs on a tick. |
| mailer | `not_configured` means no SMTP; configure it to send mail. |

## Can't reach the web UI / BFF

- The BFF binds to **`127.0.0.1:8765`** by default and refuses a non-loopback
  bind without `--allow-non-local`. Reach a remote server over an SSH tunnel:
  `ssh -L 8765:127.0.0.1:8765 you@your-server`.
- Sign-in fails / no account yet? The **first** operator is created on the
  console's one-time setup screen (only while zero operators exist) or with
  `sh-manager admin create` (see
  [security hardening](security-hardening.md)).
- A blocked request may be the Host-header (DNS-rebinding) guard — use the tunnel
  and `http://127.0.0.1:8765`, not a public hostname.
- **Updated the manager but still see the old GUI?** Manager `1.5.2+` serves the
  app shell as `no-cache`, so a `self-update` shows up on the next load. Coming
  from an older manager, do one hard refresh (`Ctrl`/`Cmd`+`Shift`+`R`) to drop
  the cached shell, and make sure only **one** `sh-manager web` process is
  running (a leftover container still bound to `127.0.0.1:8765` keeps serving the
  old version). See [reverse proxy & Apache](reverse-proxy-and-apache.md#i-updated-the-manager-but-still-see-the-old-gui).

## "DENIED (cross-instance)" from the manager

The backend never trusts a browser-provided `instanceId`; cross-instance update
attempts are denied and logged. Run `process-operations` against the **matching**
instance (the default exec transport always targets the right backend; with
`--backend-url`, use that instance's own URL and per-instance `--token`).
Detail: [update](update.md).

## CMS update request stuck on "requested"

Nothing is draining the operations queue. The CMS System page shows the
**manager loop** component ("last seen") — `down` or stale means no drain loop
has contacted this instance recently. Start one:

- the web console (`sh-manager web`, wrapper: `./shm.sh up`) drains all
  instances automatically — see
  [GUI instance management](gui-instance-management.md);
- or run `sh-manager instance process-operations <id>` once / wire the
  systemd-or-cron trigger from [`deploy/`](../../deploy/README.md);
- `not_configured` means the instance has no manager token (installed by a
  manager `< 0.1.6`): run `sh-manager instance update <id>` or
  `sh-manager instance repair <id>` to backfill it, which recreates the
  backend with the token injected.

## Instance shows `broken` / "Instance not found in this state root"

A `broken` badge in `instance list` (or an error naming the state root and the
known instances) means the instance's manifest is missing or unreadable while
other state (lock file, compose file, backups) still exists.
`sh-manager instance repair <id>` reconstructs the manifest from the newest
backup snapshot, or from the inventory + lock + compose files when no backup
exists, and re-registers the instance in the inventory if needed.

## Still stuck

Collect a redacted [support bundle](support-bundle.md) and include what you were
doing, the exact command, and the output of `sh-manager instance health <id>` and
`sh-manager doctor`.
