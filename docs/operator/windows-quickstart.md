# Windows quickstart: run the manager from the Docker image

Audience: Operators and developers testing SelfHelp on a Windows machine
Status: Active
Applies to: `sh-manager` >= 0.1.6 (Docker image), Windows 10/11 + Docker Desktop (WSL2 backend)
Last verified: 2026-06-12
Source of truth: `apps/cli/src/bin.ts`, `apps/cli/src/wrapper.ts`, `packages/docker/src/host-paths.ts`, `Dockerfile`, [install.md](install.md)

This guide runs the **published manager image** on Windows — no Node.js, no
git checkout, no path tricks. You get the same bits a Linux production server
runs. Use it to:

- install one or **several** SelfHelp instances side by side on different
  localhost ports (local mode: plain HTTP, no domains, no SSL certificates),
- open the **GUI** (install wizard / operations console) in your browser,
- test the CMS, update instances, and update the manager itself.

If you want to hack on the manager/CMS source and publish test releases to a
local registry instead, use the
[local Windows walkthrough](local-windows-walkthrough.md) (from-source).
Production servers: [install.md](install.md).

## 0. One-time setup

1. Install **Docker Desktop** with the **WSL2 backend** and start it (wait
   until the whale icon is steady).
2. Open **PowerShell** (everything below is PowerShell; Git Bash users: see
   the note at the end of this section).
3. If you have never run a local PowerShell script on this machine, allow them
   once (locally created scripts only; this is the standard developer setting):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 1. Get the manager + its wrapper script

Pick a folder on a local drive for all SelfHelp state (instances, configs,
backups) — for example `D:\selfhelp` — and let the image generate its own
wrapper script into it:

```powershell
docker pull ghcr.io/humdek-unibe-ch/sh-manager:latest

mkdir D:\selfhelp
cd D:\selfhelp
docker run --rm ghcr.io/humdek-unibe-ch/sh-manager:latest wrapper --shell powershell > shm.ps1
```

That's the whole setup. `shm.ps1` runs the manager image with the Docker
socket and the state folder mounted; its state folder is **the folder the
script lives in**, so it works from anywhere and every call is consistent.
The manager discovers how the Docker engine sees that folder by itself — you
never have to know about Docker Desktop's internal VM paths.

> Git Bash instead of PowerShell? Generate the bash flavor — it handles the
> MSYS path-mangling pitfalls internally:
> `docker run --rm ghcr.io/humdek-unibe-ch/sh-manager:latest wrapper --shell bash > shm.sh && chmod +x shm.sh`,
> then use `./shm.sh` wherever this page says `.\shm.ps1`.

## 2. Initialize the server (local mode)

```powershell
.\shm.ps1 server init --server-id win-test --mode local
.\shm.ps1 instance list
```

Local mode = instances on `http://localhost:<port>`, no domains, no
Let's Encrypt, no Traefik container. `server init` also creates the shared
`selfhelp_proxy` Docker network instances attach to.

## 3. Install instances — one port each

The official registry is the default, so a test install is one line:

```powershell
.\shm.ps1 instance install --id demo1 --mode local --port 8080 --provision --admin-email admin@example.test

# a second instance for another test - just a different id + port
.\shm.ps1 instance install --id demo2 --mode local --port 8090 --provision --admin-email admin@example.test
```

`--provision` waits for the DB, runs migrations, creates the CMS admin
(password printed **once** — save it), installs plugins, warms caches, and
health-checks. Each instance is fully isolated: own MySQL/Redis/Mercure
containers, own volumes, own secrets.

Test the CMS: open `http://localhost:8080`, log in with the admin email +
printed password. Repeat on `:8090` for `demo2`.

```powershell
.\shm.ps1 instance list
.\shm.ps1 instance health demo1
```

## 4. The GUI

```powershell
.\shm.ps1 web
```

Open the printed URL, <http://localhost:8765> (the wrapper publishes the port
loopback-only and binds the UI correctly inside the container; the manager
version is shown in the page header):

- On a fresh state folder it runs the **install wizard** (environment checks →
  registry → instance config → install) and self-locks after success. You can
  do the whole first install from the GUI instead of step 2/3 above.
- With `.\shm.ps1 web --mode persistent --persist` it serves the authenticated
  **operations console**: live environment checks, manager version + update
  status, and full **instance management** — list/health/backups, update
  dry-run + execute, restore, clone, remove, with live operation logs (see
  [GUI instance management](gui-instance-management.md)). Create an operator
  first:
  `.\shm.ps1 admin create --email you@example.test --roles server_owner --password ...`.

Stop it with `Ctrl+C`.

In Docker Desktop the GUI container is named `sh-manager-web` (CLI calls run as
short-lived `sh-manager-cli-<pid>` containers); instance stacks are grouped
under `selfhelp_<instance-id>`.

## 5. Update an instance

```powershell
.\shm.ps1 instance update demo1 --dry-run     # plan + preflight only
.\shm.ps1 instance update demo1               # backup-first, rollback-on-failure
```

Or from the CMS: **Admin → System → Maintenance & updates** requests an
update; the manager executes it. The wiring is automatic — the per-instance
manager token is generated at install and injected into the backend, and the
manager execs into the backend container to claim operations (no URL, no
manual token):

```powershell
.\shm.ps1 instance process-operations demo1
```

Even easier: keep the persistent GUI running (`.\shm.ps1 web --mode persistent
--persist`) — it drains CMS-requested operations for all instances every 15
seconds and shows each run's log in the operation history (see
[GUI instance management](gui-instance-management.md)). An instance installed
by an older manager gets the token backfilled by its next
`instance update` or `instance repair`.

## 6. Update the manager itself

```powershell
.\shm.ps1 self-update           # checks, pulls the new image, restarts the GUI
.\shm.ps1 self-update --check   # check only (exit 2 = update available)
```

`self-update` pulls the new image tags and — when the `sh-manager-web` GUI
container is running — recreates it on the new image with the same port,
mounts, and arguments (a terminal attached to the old GUI container is
released; the GUI comes back on <http://localhost:8765> after a few seconds).
Every next `.\shm.ps1 ...` call uses the new image — the wrapper always runs
`:latest` and `--rm` containers carry no state; everything lives in your state
folder. The GUI shows the same information on the operations console
("Manager version" card).

## 7. Clean up

```powershell
.\shm.ps1 instance remove demo2 --mode full_delete --delete-volumes --confirm "delete demo2"
# after removing all instances:
cd \
Remove-Item -Recurse -Force D:\selfhelp
```

## How this works (and the manual alternative)

The manager container drives the **host's** Docker engine through the mounted
socket, so paths in generated compose files must make sense to the *engine*,
not to the manager container. Since 0.1.5 the manager inspects its own
container at startup, learns where the engine sees the state folder (on Docker
Desktop: `/run/desktop/mnt/host/d/selfhelp` for `D:\selfhelp`), and translates
every engine-bound path automatically. Older versions required you to mount
the state folder at that VM path yourself.

So the wrapper is convenience, not magic — a plain `docker run` works too:

```powershell
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v D:\selfhelp:/opt/selfhelp ghcr.io/humdek-unibe-ch/sh-manager:latest instance list
```

Escape hatch: if self-inspection is impossible in your setup (e.g. a custom
`--hostname` on the manager container), set `-e SELFHELP_ENGINE_ROOT=<path>`
to the engine's view of the state folder, or `off` to disable translation.

> Why a folder and not a named volume? Instance stacks bind-mount files from
> the state folder (compose files, secrets), and you want to inspect it with
> Explorer. Keep it on a local NTFS drive.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `.\shm.ps1` fails with "running scripts is disabled on this system" | One-time: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (step 0). |
| `unknown command 'sh-manager'` | Fixed in >= 0.1.6: a redundant leading `sh-manager` token (`.\shm.ps1 sh-manager instance list`) is now stripped by the wrapper and the CLI. On older images, drop the `sh-manager` word — the wrapper already *is* the manager. |
| `Instance "<id>" not found in this state root` | The manifest is missing or the id is misspelled. The message lists the known instances; `.\shm.ps1 instance list` shows `broken` entries, and `.\shm.ps1 instance repair <id>` reconstructs a lost manifest from the newest backup or the remaining metadata. |
| `ENOENT ... selfhelp.server.json` + "not initialized" on every command | The state mount differs between calls. Use the wrapper script (it bakes the folder in); if running `docker run` by hand, pass the exact same `-v <folder>:/opt/selfhelp` every time. |
| `invalid reference format` or a path like `C:\Program Files\Git\run\...` in errors | Git Bash path mangling on hand-written `docker run` commands. Use the generated `shm.sh` (it disables the mangling) or prefix manual commands with `MSYS_NO_PATHCONV=1`. |
| Instance containers start but secrets/JWT files appear empty | Manager < 0.1.5 with a state mount that differs between the engine and the container. Update the image, or use the old same-path mount (`-v /run/desktop/mnt/host/d/selfhelp:/run/desktop/mnt/host/d/selfhelp`). |
| `network selfhelp_proxy declared as external, but could not be found` | Server was bootstrapped by a manager < 0.1.4. Run `docker network create selfhelp_proxy` once, or re-run any `instance install --up` with a current image (it re-ensures the network). |
| Health probe fails but `http://localhost:<port>` works in the browser | Manager < 0.1.4 probed `localhost` inside its own container. Update the image; or set `SELFHELP_LOCALHOST_PROBE_HOST=host.docker.internal`. |
| GUI port unreachable | Use `.\shm.ps1 web` (it publishes `127.0.0.1:8765` and binds `0.0.0.0` inside the container), then browse `http://localhost:8765` — never `http://0.0.0.0:8765`, which is a bind address, not a URL. For manual `docker run`, add `-p 127.0.0.1:8765:8765` and `web --host 0.0.0.0`. |
| Wizard says "Provisioning failed at …" (e.g. `admin`, `wait_db`) | The checklist marks the failing step and the red box carries the underlying error. First thing to try: `docker pull ghcr.io/humdek-unibe-ch/sh-manager:latest` — `:latest` is only re-resolved when you pull, so a stale image keeps already-fixed provisioning bugs (e.g. the pre-1.0.6 backend `MERCURE_URL` bug that broke admin creation). Then hit **Retry installation**. |
| `wait_db` fails with `Unable to read the "/app/.env" environment file` | Core images up to 0.1.2 ship no `/app/.env`, which Symfony requires to boot. Fixed in manager >= 1.0.10: the instance's `.env` is bind-mounted at `/app/.env`, so every published core installs. Pull the latest manager image and reinstall — it continues where it stopped. |
| Retry after a failed install says "This server is already bootstrapped" | Fixed in manager >= 1.0.10, **including after a manager update/restart in between**: the install resumes the half-bootstrapped state automatically as long as no *other* instance exists on the server (inventory/proxy/instance folder are reused, secrets on disk are kept so the DB volume still matches its credentials). Nothing needs to be deleted — re-run the wizard with the same instance id. On an old image, delete the instance folder and `selfhelp.server.json` from the state folder and start over. |
| Everything is slow | Keep the state folder on a local NTFS drive (not a network share); make sure Docker Desktop uses the WSL2 backend. |

## Where to go next

- Production install on a Linux server (domains + HTTPS): [install.md](install.md)
- From-source Windows development + local test registry:
  [local-windows-walkthrough.md](local-windows-walkthrough.md)
- Updates in depth (plans, rollback, CMS-requested):
  [update.md](update.md)
