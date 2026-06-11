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
  (backup-first, rollback-on-failure), backups, restores, clones, and redacted
  support bundles.

It ships **two interfaces over the same logic**: the `sh-manager` **CLI** (the
canonical interface) and a localhost **web UI** (`sh-manager-web`) — an install
wizard, an operations console, and operator login.

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

## Update the manager

```bash
# Docker image (exit code 2 = update available):
docker run --rm ghcr.io/humdek-unibe-ch/sh-manager:latest self-update
docker pull ghcr.io/humdek-unibe-ch/sh-manager:latest   # apply

# Source checkout:
git pull && npm ci && npm run build
```

`sh-manager self-update` checks the official GitHub releases and prints the
exact commands for your runtime; the web UI's operations console shows the
same "update available" status. Long-running `process-operations` loops must
be restarted after a pull. Release notes: [`CHANGELOG.md`](CHANGELOG.md).

## Documentation

Full documentation lives in [`docs/`](docs/README.md):

- Developers: [architecture](docs/architecture.md),
  [developer guide](docs/developer-guide.md),
  [release & publishing](docs/release-publishing.md).
- Operators: [install](docs/operator/install.md),
  [Windows quickstart](docs/operator/windows-quickstart.md),
  [update](docs/operator/update.md),
  [backup & restore](docs/operator/backup-restore.md),
  [clone & remove](docs/operator/clone-remove.md),
  [safe mode & recovery](docs/operator/safe-mode-and-recovery.md),
  [support bundle](docs/operator/support-bundle.md),
  [security hardening](docs/operator/security-hardening.md).
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
# printed once and never written to disk/manifest/lock.
sh-manager instance install --id website1 --domain website1.example.ch \
  --version latest --provision --admin-email ops@example.ch

sh-manager instance list
sh-manager instance health website1
sh-manager instance update --dry-run website1
sh-manager instance update website1 --accept-migration-risk
sh-manager doctor
sh-manager self-update      # is a newer manager released? (exit 2 = yes)
sh-manager web              # serve the web UI (wizard / operations console)
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

- **Install wizard** (bootstrap mode): preflight checks → mode/domain/instance
  config → review → install, with a success screen. It binds to `127.0.0.1`,
  guards against DNS-rebinding, and **self-locks** after a successful install.
- **Operator login + operations console** (persistent mode): an authenticated
  session (cookie + CSRF) gates the management API; the console shows live server
  status and the operator actions for instance lifecycle.

The **BFF** is the only thing the SPA talks to. It exposes the CLI actions as a
tiny JSON API under `/api`, binds to localhost by default (a non-loopback bind
must be opted into explicitly), and serves the built SPA from `dist-web` (falling
back to an inline shell if unbuilt). Reach it remotely via an SSH tunnel:

```bash
# on the server (equivalent: sh-manager-web)
sh-manager web --root /opt/selfhelp        # bootstrap wizard, http://127.0.0.1:8765
sh-manager web --root /opt/selfhelp --mode persistent --persist   # management UI

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
