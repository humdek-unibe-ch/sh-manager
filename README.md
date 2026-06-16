# SelfHelp Manager (`sh-manager`)

The official **Docker-only, connected** installer, updater, and multi-instance
server manager for [SelfHelp](https://github.com/humdek-unibe-ch). `sh-manager`
is the **only** component that is allowed to talk to Docker. The Symfony CMS
never controls Docker directly.

> Status: MVP. Tracking issue: humdek-unibe-ch/sh-manager#1.

## What it does

- Bootstraps a server: one shared Traefik reverse proxy + a server inventory.
- Installs isolated SelfHelp instances from the **one official registry**
  (signed, ready-built core/frontend/scheduler/worker images — no building on
  the server).
- Resolves compatible versions (core ⇄ frontend ⇄ plugins ⇄ plugin API),
  honouring security advisories.
- Generates per-instance Docker Compose, `.env` (non-secret), manifest, lock
  file, and an operator README.
- Runs preflight/resource checks, health checks, update dry-runs and updates
  (backup-first, rollback-on-failure), backups — manual and **scheduled nightly
  with GFS retention** — restores, clones, and redacted support bundles.

It ships **two interfaces over the same logic**: the `sh-manager` **CLI** (the
canonical interface) and a localhost **web UI** (`sh-manager-web`) — one
operations console with operator login and a guided, full-page wizard for
creating instances (the first run also sets up the server itself).

## Install the manager

The manager ships as a Docker image (recommended — nothing to build) and as
this source repo (development).

### Linux server (production)

Install the **wrapper script** once as a real command on your `PATH`
(`/usr/local/bin/shm`). The wrapper bakes in the Docker socket + state mounts
**and** the GUI port publishing, and it adds the lifecycle verbs
(`up`/`down`/`update`/`reinstall`/`web`); anything else is passed straight to the
`sh-manager` CLI. `--state-root` bakes `/opt/selfhelp` into the script so it works
from any directory and **survives new SSH sessions** (unlike a shell `alias`).

```bash
docker pull ghcr.io/humdek-unibe-ch/sh-manager:latest

mkdir -p /opt/selfhelp
docker run --rm ghcr.io/humdek-unibe-ch/sh-manager:latest \
  wrapper --shell bash --state-root /opt/selfhelp | sudo tee /usr/local/bin/shm >/dev/null
sudo chmod +x /usr/local/bin/shm
shm --version                       # `shm` is now a permanent command, every shell

shm server init --server-id srv-001 --mode production --email ops@example.ch
shm instance install --id website1 --domain website1.example.ch \
  --version latest --provision --admin-email ops@example.ch
shm up                              # start the web GUI at http://127.0.0.1:8765
```

(The official registry is the default; pass `--registry <url>` for dev/test
registries.) Full guide: [docs/operator/install.md](docs/operator/install.md).

> **Do not use a shell `alias` for `shm`.** An alias only exists in the one
> shell that defined it, so a new SSH session fails with
> `shm: command not found`. Installing the script to `/usr/local/bin/shm` as
> above makes it permanent for every shell and user. (You also cannot just
> *symlink* the script onto `PATH`: without `--state-root` it would look for
> state next to the symlink — always generate it with `--state-root`.)
>
> If you instead point `shm` at a bare `docker run … sh-manager` (CLI only), the
> lifecycle verbs do **not** exist — `shm up` / `shm down` / `shm reinstall`
> fail with `unknown command`, and `shm web` will **not** publish the GUI port
> (so an SSH tunnel can't reach it). Use the wrapper above for the GUI, or
> publish the port yourself (see [Web UI](#web-ui)).

### Windows machine (testing)

Same image. Pick a state folder (e.g. `D:\selfhelp`), let the image generate
its wrapper script into it, and use that for everything — the manager
discovers Docker Desktop's engine-side paths automatically (no VM paths, no
Git Bash path mangling):

```powershell
mkdir D:\selfhelp; cd D:\selfhelp
docker run --rm ghcr.io/humdek-unibe-ch/sh-manager:latest wrapper --shell powershell > shm.ps1
.\shm.ps1 server init --server-id win-test --mode local
.\shm.ps1 instance install --id demo1 --mode local --port 8080 --provision --admin-email admin@example.test
.\shm.ps1 web   # GUI at http://127.0.0.1:8765
```

Local mode runs instances on plain `http://localhost:<port>` — no domains, no
SSL — and as many side-by-side instances as you have ports.
Full guide: [docs/operator/windows-quickstart.md](docs/operator/windows-quickstart.md).

### From source (development)

```bash
npm install && npm run build
npm run cli -- --help
```

## Manager lifecycle (the GUI container)

These verbs are provided by the generated **wrapper script** (`shm.sh` /
`shm.ps1`) — they manage the single long-running `sh-manager-web` GUI container.
They are **not** `sh-manager` CLI subcommands, so they only work through the
installed `shm` wrapper command. All state lives in the mounted state
folder, so the manager container itself is **disposable**: removing and
reinstalling it never touches instances, and a fresh manager reconnects to every
existing instance automatically.

```bash
shm up           # start the web GUI in the background (http://127.0.0.1:8765)
shm down         # stop + remove the GUI container (instances keep running)
shm update       # self-update: pull the new image + restart the GUI on it
shm reinstall    # down + docker pull + up (fresh container, latest image, same state)
shm web          # run the GUI in the foreground (Ctrl-C stops it)
```

(`shm` is the wrapper command you installed to `/usr/local/bin/shm`; on Windows
use `.\shm.ps1 <verb>`.) **`shm reinstall` is the clean rebuild**: it removes the
old GUI container, pulls the latest published image, and starts a fresh
`sh-manager-web` on it — so the GUI is rebuilt with the latest manager release
while every instance and all state survive untouched. After an
`update`/`reinstall`, hard-refresh the browser **once** so it drops the old SPA
shell; from then on the new GUI version shows without a refresh.

> `update`/`reinstall` run the latest **published** image. If you are testing
> unreleased changes, run the manager from a source checkout instead (see
> [From source](#from-source-development)), where `self-update` does
> `git pull --ff-only && npm ci && npm run build` and you restart `shm web`.

Everything else is a normal `sh-manager` CLI subcommand (run through the wrapper
or the image directly). The lifecycle-relevant ones:

```bash
shm self-update                 # check + APPLY the manager update (same as `shm update`)
shm self-update --check         # check only (exit code 2 = update available)
shm server status               # initialized? which instances are managed?
shm server start                # (re)start the shared Traefik proxy (production) — repair routing/TLS
shm server logs [--tail 200]    # recent reverse-proxy (Traefik) logs — redacted; diagnose 404 / TLS
shm instance remove <id> --mode disable   # "down" ONE instance (stop containers, keep all data)
shm instance enable <id>                   # "up" that instance again
shm server purge --confirm "purge selfhelp"   # DANGER: delete everything
```

`self-update` checks the official GitHub releases and applies the update for
your runtime: on the Docker image it pulls the new tags and **restarts the
`sh-manager-web` GUI container** on the new image (same port, mounts, and
arguments); on a source checkout it runs `git pull --ff-only && npm ci &&
npm run build`. Long-running `process-operations` loops must be restarted
after an update.

`server start` (re)starts the shared proxy that terminates TLS and routes every
production instance. Use it when instances are installed but unreachable / health
shows `backend fetch failed` / `frontend unreachable` (e.g. after a failed first
bootstrap or a host that booted before Docker). See
[reverse proxy & Apache](docs/operator/reverse-proxy-and-apache.md).

`server purge` is the full tear-down: it removes **every instance**
(containers, volumes, data, secrets), the shared Traefik proxy, and all server
state — backups are kept unless `--delete-backups` is passed. It requires the
literal confirmation `--confirm "purge selfhelp"`. Release notes:
[`CHANGELOG.md`](CHANGELOG.md).

## Documentation

Full documentation lives in [`docs/`](docs/README.md):

- Developers: [architecture](docs/architecture.md),
  [developer guide](docs/developer-guide.md),
  [release & publishing](docs/release-publishing.md).
- Operators: [install](docs/operator/install.md),
  [Windows quickstart](docs/operator/windows-quickstart.md),
  [GUI instance management](docs/operator/gui-instance-management.md),
  [update](docs/operator/update.md),
  [backup & restore](docs/operator/backup-restore.md),
  [scheduled backups](docs/operator/scheduled-backups.md),
  [clone & remove](docs/operator/clone-remove.md),
  [safe mode & recovery](docs/operator/safe-mode-and-recovery.md),
  [support bundle](docs/operator/support-bundle.md),
  [security hardening](docs/operator/security-hardening.md).
- QA: [manual test plan](docs/qa/manual-test-plan.md) +
  [results template](docs/qa/results-template.md).
- [`CHANGELOG.md`](CHANGELOG.md) and the repository contract [`AGENTS.md`](AGENTS.md).

## Hard rules (enforced in code + tests)

- Production is **Docker-only and connected**. The server never runs
  `npm build`, `composer install`, or any compilation; it pulls **signed**
  artifacts.
- Exactly **one** official registry (`sh2-plugin-registry`).
- `sh-manager` owns Docker access; the CMS does not.
- CMS update management is **instance-scoped**; the backend never trusts a
  browser-provided `instanceId`; cross-instance attempts are denied and logged.
- **No runtime container mounts the Docker socket** (only the shared Traefik
  proxy does, read-only). Enforced by `@shm/docker` guards.
- `docker compose down -v` and MySQL-volume deletion are blocked: DB, uploads,
  plugin artifacts, secrets, backups, and logs **survive updates**.

## Architecture

npm-workspaces TypeScript monorepo. Decision logic is pure and unit-tested; all
Docker / network / filesystem side effects live behind injected boundaries.

| Package | Responsibility |
| --- | --- |
| `@shm/schemas` | Types, JSON Schemas, schema-version gating, validators |
| `@shm/registry` | Canonical JSON, Ed25519 signatures, SHA-256 checksums, registry client |
| `@shm/resolver` | Semver + advisory + core/frontend/plugin compatibility resolution |
| `@shm/docker` | Per-instance compose generation, `.env` (BFF invariant), safety guards, runner |
| `@shm/traefik` | The single shared reverse proxy |
| `@shm/instances` | Paths, atomic writes, inventory/manifest/lock stores, drift, README |
| `@shm/core` | Instance-scope guard, preflight, health, update plan/execute, bootstrap/install, post-up provisioning |
| `@shm/backup` | Backup manifest + integrity, restore/clone planning |
| `@shm/support` | Secret redaction + support bundle assembly |
| `@shm/auth` | Local operator authentication (email + password), roles, sessions, CSRF |
| `apps/cli` | `sh-manager` command-line entrypoint |
| `apps/web` | `sh-manager-web` localhost web UI: Vite React SPA + Node BFF |

## Requirements

- Docker Engine + Docker Compose v2 on the server (that's all when using the
  manager image).
- Node.js >= 22 only when running the manager from source.

## Develop

```bash
npm install
npm run check        # typecheck + lint + test + validate:schemas
npm run cli -- --help
```

Other scripts: `npm run build`, `npm run fixtures:sign`, `npm run license:report`.

## CLI

Examples use `shm` — your alias to the wrapper script (see
[Install](#linux-server-production)). The underlying binary is `sh-manager`, so
`shm server status` runs the image's `sh-manager server status`. Run `shm --help`
or `shm <group> --help` for the full, authoritative option list.

### Complete command reference

Top-level:

| Command | What it does |
| --- | --- |
| `wrapper --shell bash\|powershell` | Print the `shm` wrapper script (socket+state mounts, GUI port, lifecycle verbs). |
| `web [--host <h>] [--port <n>]` | Serve the localhost web UI (operations console + create wizard). |
| `self-update [--check]` | Update the manager image/checkout. `--check`: report only (exit 2 = update available). |
| `doctor` | Host resource preflight (Docker, internet, ports 80/443, disk/memory/CPU). |

`server` (server-level):

| Command | What it does |
| --- | --- |
| `server init --server-id <id> --mode production\|local [--email <e>] [--import]` | One-time bootstrap: shared Traefik proxy + inventory. `--import` re-applies/repairs an existing server. |
| `server status` | Is the server initialized, and which instances does it manage? |
| `server start` | (Re)start the shared Traefik proxy (production). Repairs unreachable instances / missing TLS. |
| `server logs [--tail <n>]` | Recent shared-proxy (Traefik) logs, secret-redacted. Diagnose 404 / no-certificate from the edge. Also in the web console → Reverse proxy → View proxy logs. |
| `server run-scheduled-backups` | Run any due scheduled backups once (for cron/systemd). |
| `server purge --confirm "purge selfhelp" [--delete-backups]` | DANGER: remove every instance, the proxy, and all server state. |

`instance` (instance-level — `<id>` is the instance id):

| Command | What it does |
| --- | --- |
| `instance install --id <id> [--mode production\|local] [--domain <d>\|--port <p>] [--version latest] [--up] [--provision --admin-email <e>] [--registry <url>]` | Install an instance from the official registry (optionally start + fully provision). |
| `instance list` | List installed instances (id, domain, status, project). |
| `instance health <id>` | Health-check an instance. |
| `instance enable <id>` | **"up"**: bring a disabled / removed-keep-data instance back online. |
| `instance remove <id> --mode disable\|remove_containers_keep_data\|full_delete` | **"down" / delete**: `disable` stops it (keeps all data); `full_delete` needs `--confirm "delete <id>"`. |
| `instance update <id> [--dry-run] [--version <v>] [--accept-migration-risk] [--approve-mysql-major]` | Plan or run a core update (backup-first, rollback on failure; also pulls a newer compatible frontend). |
| `instance update-frontend <id> [--dry-run] [--version <v>]` | Frontend-only swap (no migration/backup; core + data untouched). |
| `instance set-address <id> --domain <d>\|--port <p>` | Re-point an instance to a new domain/port and recreate routing. |
| `instance rename <id> <displayName>` | Change only the display name. |
| `instance mailer <id> [--set <dsn>\|--clear]` | Show / set / reset the outbound SMTP DSN (returned redacted). |
| `instance env <id> [--set K=V ...] [--unset K ...]` | Show / override / reset non-secret environment. |
| `instance backup <id>` | Take a manual backup. |
| `instance backup-schedule <id> --enable --time HH:MM` | Configure nightly backups (GFS retention). |
| `instance backup-prune <id> [--dry-run]` | Apply the retention policy. |
| `instance restore <id> <backupId> [--apply]` | Restore a backup in place (or as a clone). |
| `instance clone <source> <target> --domain <d>\|--port <p> [--apply]` | Copy an instance into a new, isolated one. |
| `instance logs <id> [-s <service>] [-n <lines>]` | Recent, redacted container logs. |
| `instance support-bundle <id>` | Collect a redacted support bundle. |
| `instance repair <id>` | Reconstruct a missing/corrupt manifest and re-register. |
| `instance safe-mode enable\|disable <id>` | Boot the backend with core bundles only (no plugins) / restore. |
| `instance process-operations <id> [--watch] [--interval <s>]` | Drain CMS-requested update/plugin operations (supervised loop with `--watch`). |

`admin` (manager operators — local email + password):

| Command | What it does |
| --- | --- |
| `admin create --email <e> --roles server_owner,instance_operator,read_only [--name <n>]` | Create an operator (password generated + shown once if omitted). |
| `admin list` | List operators (digests never shown). |
| `admin disable <email>` | Block an operator's login (keeps the record). |
| `admin role grant <email> <role>` | Grant a role. |
| `admin bootstrap-token [--ttl <s>]` | Issue a one-time first-run operator-creation token. |

### Common flows

```bash
# one-time server bootstrap (shared proxy + inventory)
shm server init --server-id srv-001 --mode production --email ops@example.ch

# install AND fully provision (wait for DB -> migrate -> create admin ->
# install plugins -> warm caches -> health). A generated admin password is
# printed once and saved to <instance>/secrets/admin_password (0600, never in
# the manifest/lock/logs); delete the file after the first sign-in.
shm instance install --id website1 --domain website1.example.ch \
  --version latest --provision --admin-email ops@example.ch

shm instance list
shm instance health website1
shm instance update website1 --dry-run
shm instance update website1 --accept-migration-risk

# stop / start ONE instance (no data is ever deleted)
shm instance remove website1 --mode disable   # "down"
shm instance enable website1                   # "up"

# routing/TLS not working? (re)start the shared proxy
shm server start

# manual + scheduled backups
shm instance backup website1
shm instance backup-schedule website1 --enable --time 02:00

shm server status
shm doctor
shm self-update                 # --check: report only (exit 2 = update available)

# DANGER: remove everything the manager created (keeps backups unless --delete-backups)
shm server purge --confirm "purge selfhelp"
```

Configuration via env: `SELFHELP_ROOT` (default `/opt/selfhelp`),
`SELFHELP_TRUSTED_KEYS` (path to the registry trusted-keys file; defaults to
the pinned **official production key** shipped at
`packages/schemas/keys/official-trusted-keys.json` — only override for dev/test
registries).

## Web UI

`sh-manager-web` serves a localhost web UI over the same actions as the CLI. It is
a **Vite React SPA + a small Node BFF** (backend-for-frontend), aligned with
`sh-selfhelp_frontend`: **React 19**, **Mantine 9**, **Tailwind 4**, and
**@tanstack/react-query**.

There is **one UI: the operations console.** An authenticated session
(cookie + CSRF) gates the management API; the console shows live server
status and the full instance lifecycle (create, health, logs, backups,
restore, update, clone, remove, outbound mail). It binds to `127.0.0.1` and
guards against DNS-rebinding. See
[docs/operator/gui-instance-management.md](docs/operator/gui-instance-management.md).

- **First run**: on a fresh state folder the console asks you to create the
  first operator account in the browser (localhost-only) — no CLI needed.
  Additional operators:
  `sh-manager admin create --email you@example.org --roles server_owner`
  (the generated password is printed once; see
  [docs/operator/security-hardening.md](docs/operator/security-hardening.md)).
- **Create-instance wizard**: a guided, full-page flow (Welcome → Preflight →
  Basics → Address → Release → Review → live install log). It opens
  automatically when no instances exist yet; the **first** install also
  bootstraps the server (shared proxy + inventory) and, in production mode,
  asks for the Let's Encrypt e-mail. Re-run the preflight checks any time from
  the dashboard.

The **BFF** is the only thing the SPA talks to. It exposes the CLI actions as a
tiny JSON API under `/api`, binds to localhost by default (a non-loopback bind
must be opted into explicitly), and serves the built SPA from `dist-web` (falling
back to an inline shell if unbuilt). Reach it remotely via an SSH tunnel:

```bash
# on the server — the wrapper publishes the GUI port for you
shm up          # background (http://127.0.0.1:8765); `shm web` runs it in the foreground
shm down        # stop it

# equivalent explicit docker run (bind 0.0.0.0 inside; published loopback-only).
# NOTE the `-p` — a bare `docker run … web` WITHOUT it leaves the GUI unreachable.
docker run --rm -p 127.0.0.1:8765:8765 \
  -v /var/run/docker.sock:/var/run/docker.sock -v /opt/selfhelp:/opt/selfhelp \
  ghcr.io/humdek-unibe-ch/sh-manager:latest web --host 0.0.0.0

# from your machine
ssh -L 8765:127.0.0.1:8765 you@your-server # then open http://127.0.0.1:8765
```

See [docs/operator/install.md](docs/operator/install.md) and
[docs/operator/security-hardening.md](docs/operator/security-hardening.md) for the
full flow and the production checklist.

## Running the manager in Docker

`sh-manager` is the single privileged tool, so it is the only container that
receives the Docker socket:

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/selfhelp:/opt/selfhelp \
  ghcr.io/humdek-unibe-ch/sh-manager:latest instance list
```

This is deliberately different from instance runtime containers, which must
never receive the socket.

Two rules make this reliable everywhere:

- **Mount a state folder at `/opt/selfhelp` inside the container.** The
  manager drives the *host* engine through the socket; when the engine sees
  that folder under a different path (Docker Desktop on Windows/macOS, or any
  non-default host folder), the manager discovers the engine-side path by
  inspecting its own container and translates generated bind mounts
  automatically (`SELFHELP_ENGINE_ROOT` overrides/disables this).
- **Use the exact same `-v` flags for every invocation** — or generate the
  wrapper script once (`sh-manager wrapper --shell powershell|bash`), which
  bakes them in. If the state mount is missing or different, commands fail
  with `ENOENT ... selfhelp.server.json` ("not initialized").

## Security model

- Releases are Ed25519-signed and SHA-256-checksummed; the client refuses
  unsigned/untrusted/`dev`-keyed releases in production.
- Canonical JSON (`@shm/registry`) is byte-compatible with the registry signer
  and the host PHP `SignedPayloadBuilder`.
- Support bundles are redacted and re-scanned for residual secrets before they
  are written.

## License

MPL-2.0.
