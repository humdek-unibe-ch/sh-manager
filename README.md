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

```bash
docker pull ghcr.io/humdek-unibe-ch/sh-manager:latest

# every run mounts the Docker socket + the state root
alias shm='docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/selfhelp:/opt/selfhelp \
  ghcr.io/humdek-unibe-ch/sh-manager:latest'

shm server init --server-id srv-001 --mode production --email ops@example.ch
shm instance install --id website1 --domain website1.example.ch \
  --version latest --provision --admin-email ops@example.ch
```

(The official registry is the default; pass `--registry <url>` for dev/test
registries.) Instead of the alias, the image can also generate a persistent
wrapper script: `docker run --rm ghcr.io/humdek-unibe-ch/sh-manager:latest
wrapper --shell bash > /opt/selfhelp/shm.sh`.
Full guide: [docs/operator/install.md](docs/operator/install.md).

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

## Manager lifecycle (update / remove / reinstall / purge)

The generated wrapper script (`shm.ps1` / `shm.sh`) carries the whole manager
lifecycle. All state lives in the mounted state folder
(`/opt/selfhelp`, `D:\selfhelp`, …), so the manager container itself is
**disposable**: removing and reinstalling it never touches instances, and a
fresh manager reconnects to every existing instance automatically.

```bash
./shm.sh up           # start the web GUI in the background (http://127.0.0.1:8765)
./shm.sh down         # stop + remove the GUI container (instances keep running)
./shm.sh update       # self-update: pull the new image + restart the GUI on it
./shm.sh reinstall    # down + docker pull + up (fresh container, same state)
./shm.sh web          # run the GUI in the foreground (Ctrl-C stops it)
```

(Windows: the same verbs on `.\shm.ps1`.) Equivalent low-level commands:

```bash
sh-manager self-update           # check + APPLY (wrapper: ./shm.sh update)
sh-manager self-update --check   # check only (exit code 2 = update available)
sh-manager server status         # initialized? which instances are managed?
sh-manager server purge --confirm "purge selfhelp"   # DANGER: delete everything
```

`self-update` checks the official GitHub releases and applies the update for
your runtime: on the Docker image it pulls the new tags and **restarts the
`sh-manager-web` GUI container** on the new image (same port, mounts, and
arguments); on a source checkout it runs `git pull --ff-only && npm ci &&
npm run build`. Long-running `process-operations` loops must be restarted
after an update.

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
| `@shm/auth` | Configurable campus/OIDC operator authorization (old PHP plugin is reference-only) |
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

```bash
# one-time server bootstrap (shared proxy + inventory)
sh-manager server init --server-id srv-001 --mode production --email ops@example.ch

# install an isolated instance (official registry is the default;
# --registry <url> overrides it for dev/test registries)
sh-manager instance install --id website1 --domain website1.example.ch \
  --version latest --up

# install AND fully provision (wait for DB -> migrate -> create admin ->
# install plugins -> warm caches -> health). A generated admin password is
# printed once and saved to <instance>/secrets/admin_password (0600, never in
# the manifest/lock/logs); delete the file after the first sign-in.
sh-manager instance install --id website1 --domain website1.example.ch \
  --version latest --provision --admin-email ops@example.ch

sh-manager instance list
sh-manager instance health website1
sh-manager instance update --dry-run website1
sh-manager instance update website1 --accept-migration-risk

# outbound mail (SMTP) per instance: show / set / back to default
sh-manager instance mailer website1
sh-manager instance mailer website1 --set smtp://user:pass@mail.example.org:587
sh-manager instance mailer website1 --clear

# manual backups + automatic nightly backups with GFS retention
sh-manager instance backup website1
sh-manager instance backup-schedule website1 --enable --time 02:00
sh-manager instance backup-prune website1 --dry-run
sh-manager server run-scheduled-backups   # one-shot for cron/systemd hosts

sh-manager server status    # initialized? which instances?
sh-manager doctor
sh-manager self-update      # update the manager (--check: report only, exit 2 = update available)
sh-manager web              # serve the web UI (operations console + create wizard)

# DANGER: remove everything the manager created (keeps backups unless --delete-backups)
sh-manager server purge --confirm "purge selfhelp"
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
# on the server (equivalent: sh-manager-web)
sh-manager web --root /opt/selfhelp        # operations console (first-run setup on a fresh server)

# from the Docker image (bind 0.0.0.0 inside; published loopback-only)
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
