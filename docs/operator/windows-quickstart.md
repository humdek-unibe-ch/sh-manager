# Windows quickstart: run the manager from the Docker image

Audience: Operators and developers testing SelfHelp on a Windows machine
Status: Active
Applies to: `sh-manager` >= 0.1.4 (Docker image), Windows 10/11 + Docker Desktop (WSL2 backend)
Last verified: 2026-06-10
Source of truth: `apps/cli/src/bin.ts`, `apps/cli/src/env.ts` (`localhostProbeHost`), `Dockerfile`, [install.md](install.md)

This guide runs the **published manager image** on Windows — no Node.js, no
git checkout. You get the same bits a Linux production server runs, so what
you test here is what production does. Use it to:

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
2. Open a terminal:
   - **Git Bash** — every command below works as written, **but** Git Bash
     rewrites Unix-style paths (`/run/...`, `/var/...`) into Windows paths
     before Docker ever sees them. The `MSYS_NO_PATHCONV=1` prefix in the
     commands below disables that. Do not drop it.
   - **PowerShell** — drop the `MSYS_NO_PATHCONV=1` prefix and replace `\`
     line continuations with `` ` ``.

## 1. The one trick: a path the engine and the manager both see

The manager container drives the **host's** Docker engine through the mounted
socket (`docker compose` runs inside the container, the containers it starts
run on the host engine). That only works when every path the manager writes is
**the same path** from the engine's point of view — on Linux that is the
documented `-v /opt/selfhelp:/opt/selfhelp`.

On Docker Desktop the engine lives in a Linux VM, and your Windows drives are
visible inside that VM under `/run/desktop/mnt/host/<drive>/...`. So pick a
state folder on a local drive, e.g. `D:\selfhelp`, and always refer to it by
its VM path:

```text
Windows path        D:\selfhelp
Engine (VM) path    /run/desktop/mnt/host/d/selfhelp
```

Define an alias once per terminal session and use it for every manager call:

```bash
# Git Bash — adjust the drive letter/folder once, reuse everywhere.
export SH_ROOT=/run/desktop/mnt/host/d/selfhelp
mkdir -p /d/selfhelp

shm() {
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$SH_ROOT:$SH_ROOT" \
    -e SELFHELP_ROOT="$SH_ROOT" \
    ghcr.io/humdek-unibe-ch/sh-manager:latest "$@"
}
```

Everything the manager writes lands in `D:\selfhelp` where you can inspect it
with Explorer.

> Why not a named volume? Instance stacks bind-mount files from the state
> folder (compose files, secrets). A named volume's contents are not visible
> to the engine under the path the manager uses, so binds would silently
> resolve to empty directories. The VM path above is visible to **both**.

## 2. Initialize the server (local mode)

```bash
shm server init --server-id win-test --mode local
shm instance list
```

Local mode = instances on `http://localhost:<port>`, no domains, no
Let's Encrypt, no Traefik container. `server init` also creates the shared
`selfhelp_proxy` Docker network instances attach to.

## 3. Install instances — one port each

```bash
shm instance install --id demo1 --mode local --port 8080 \
  --registry https://humdek-unibe-ch.github.io/sh2-plugin-registry/ \
  --version latest --provision --admin-email admin@example.test

# a second instance for another test — just a different id + port
shm instance install --id demo2 --mode local --port 8090 \
  --registry https://humdek-unibe-ch.github.io/sh2-plugin-registry/ \
  --version latest --provision --admin-email admin@example.test
```

`--provision` waits for the DB, runs migrations, creates the CMS admin
(password printed **once** — save it), installs plugins, warms caches, and
health-checks. Each instance is fully isolated: own MySQL/Redis/Mercure
containers, own volumes, own secrets.

Test the CMS: open `http://localhost:8080`, log in with the admin email +
printed password. Repeat on `:8090` for `demo2`.

```bash
shm instance list
shm instance health demo1
```

> Health probes work from inside the manager container because the manager
> detects it is containerised and probes `host.docker.internal` instead of
> `localhost` (override with `SELFHELP_LOCALHOST_PROBE_HOST`, set `off` to
> disable; plain Linux engines need
> `--add-host=host.docker.internal:host-gateway` on the `docker run`).

## 4. The GUI from the image

The web UI is a CLI subcommand, so the same image serves it. It must bind
`0.0.0.0` **inside** the container so Docker can publish it; the published
port stays loopback-only on your machine:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -p 127.0.0.1:8765:8765 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$SH_ROOT:$SH_ROOT" \
  -e SELFHELP_ROOT="$SH_ROOT" \
  ghcr.io/humdek-unibe-ch/sh-manager:latest web --host 0.0.0.0
```

Open <http://127.0.0.1:8765>:

- On a fresh root it runs the **install wizard** (environment checks →
  registry → instance config → install) and self-locks after success.
- With `web --mode persistent --persist` it serves the authenticated
  **operations console** (live environment checks, manager version + update
  status, operator commands). Create an operator first:
  `shm admin create --email you@example.test --roles server_owner --password ...`.

## 5. Update an instance

```bash
shm instance update demo1 --dry-run     # plan + preflight only
shm instance update demo1               # backup-first, rollback-on-failure
```

Or from the CMS: **Admin → System → Maintenance & updates** requests an
update; the manager executes it. That loop authenticates with a per-instance
token you set once (in `D:\selfhelp\instances\demo1\secrets\secrets.env`, add
`SELFHELP_MANAGER_TOKEN=<a long random string>` and restart the backend
container), then:

```bash
shm instance process-operations demo1 \
  --backend-url http://host.docker.internal:8080 \
  --token "<the same token>"
```

(`host.docker.internal`, not `localhost` — the manager runs in a container.)

## 6. Update the manager itself

```bash
shm self-update
```

Prints the installed version, the latest released version, and the exact
commands when an update exists (exit code `2` = update available):

```bash
docker pull ghcr.io/humdek-unibe-ch/sh-manager:latest
```

The next `shm ...` invocation uses the new image — `--rm` containers carry no
state; everything lives in your state folder. The GUI shows the same
information on the operations console ("Manager version" card).

## 7. Clean up

```bash
shm instance remove demo2 --mode full_delete --delete-volumes --confirm "delete demo2"
rm -rf /d/selfhelp   # after removing all instances
```

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `ENOENT ... selfhelp.server.json` + "not initialized" on every command | The state mount differs between calls (or Git Bash mangled the path). Use the `shm` alias so every call carries the exact same `-v "$SH_ROOT:$SH_ROOT"` and the `MSYS_NO_PATHCONV=1` prefix. |
| `invalid reference format` or a path like `C:\Program Files\Git\run\...` in errors | Git Bash path mangling — the `MSYS_NO_PATHCONV=1` prefix is missing. |
| `network selfhelp_proxy declared as external, but could not be found` | Server was bootstrapped by a manager < 0.1.4. Run `docker network create selfhelp_proxy` once, or re-run any `instance install --up` with >= 0.1.4 (it re-ensures the network). |
| Health probe fails but `http://localhost:<port>` works in the browser | Manager < 0.1.4 probed `localhost` inside its own container. Update the image; or set `SELFHELP_LOCALHOST_PROBE_HOST=host.docker.internal`. |
| GUI port unreachable | The container must bind `0.0.0.0` (`web --host 0.0.0.0`) for `-p 127.0.0.1:8765:8765` to reach it. |
| Everything is slow | Keep the state folder on a local NTFS drive (not a network share); make sure Docker Desktop uses the WSL2 backend. |

## Where to go next

- Production install on a Linux server (domains + HTTPS): [install.md](install.md)
- From-source Windows development + local test registry:
  [local-windows-walkthrough.md](local-windows-walkthrough.md)
- Updates in depth (plans, rollback, CMS-requested):
  [update.md](update.md)
