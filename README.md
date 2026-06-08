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

## Requirements

- Node.js >= 22 (for the manager itself).
- Docker Engine + Docker Compose v2 on the server.

## Install / develop

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

# install an isolated instance from the official registry
sh-manager instance install --id website1 --domain website1.example.ch \
  --registry https://humdek-unibe-ch.github.io/sh2-plugin-registry/ --version latest --up

# install AND fully provision (wait for DB -> migrate -> create admin ->
# install plugins -> warm caches -> health). A generated admin password is
# printed once and never written to disk/manifest/lock.
sh-manager instance install --id website1 --domain website1.example.ch \
  --registry https://humdek-unibe-ch.github.io/sh2-plugin-registry/ --version latest \
  --provision --admin-email ops@example.ch

sh-manager instance list
sh-manager instance health website1
sh-manager instance update --dry-run website1
sh-manager instance update website1 --accept-migration-risk
sh-manager doctor
```

Configuration via env: `SELFHELP_ROOT` (default `/opt/selfhelp`),
`SELFHELP_TRUSTED_KEYS` (path to the registry trusted-keys file).

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

## Security model

- Releases are Ed25519-signed and SHA-256-checksummed; the client refuses
  unsigned/untrusted/`dev`-keyed releases in production.
- Canonical JSON (`@shm/registry`) is byte-compatible with the registry signer
  and the host PHP `SignedPayloadBuilder`.
- Support bundles are redacted and re-scanned for residual secrets before they
  are written.

## License

MPL-2.0.
