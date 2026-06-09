# Changelog

All notable changes to **SelfHelp Manager** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

The manager has two version axes (see
[docs/release-publishing.md](docs/release-publishing.md)):

- **The manager tool** uses its own semver (currently `0.1.0`). Registry releases
  declare a `requiresManager` constraint, so the tool version is a compatibility
  contract.
- **The SelfHelp platform** it installs/updates is currently the pre-release
  **`0.x`** line (core, frontend, scheduler, worker — all `0.1.0`).

A single manager `0.1.0` installs and manages SelfHelp `0.x` pre-release instances.

## [0.1.0] - 2026-06-08

Initial release of the SelfHelp Manager for the SelfHelp `0.x` pre-release
platform line — the official Docker-only, connected installer, updater, and
multi-instance server manager.

### Added

- **Server bootstrap** — `server init` creates the single shared Traefik reverse
  proxy and the server inventory.
- **Instance install** — `instance install` from the one official signed registry
  (no building on the server), with optional full provisioning (wait for DB →
  migrate → create admin → install plugins → warm caches → health-check) and a
  generated admin password shown once and never persisted.
- **Version resolution** — semver + security advisories + core ⇄ frontend ⇄
  plugin ⇄ plugin-API compatibility (`@shm/resolver`).
- **Updates** — `instance update` with dry-run/preflight, backup-first execution,
  rollback-on-failure, and a destructive-migration risk gate. CMS-requested,
  instance-scoped updates via `instance process-operations` (the backend never
  trusts a browser-provided `instanceId`).
- **Backups & restore** — checksummed backup manifests (`instance backup`) and
  validated restores (`instance restore`) with explicit secret policy
  (`same_instance` preserves secrets, `restore_as_clone` regenerates them) plus a
  disaster-recovery import path.
- **Clone & remove** — isolated clones with fresh secrets (`instance clone`) and
  three-tier removal (`disable`, `remove_containers_keep_data`, `full_delete`)
  with typed confirmation for destructive deletes.
- **Plugin safe-mode & diagnostics** — `instance safe-mode enable|disable`,
  `instance health`, host `doctor`, and redacted `instance support-bundle`.
- **Operators & auth** — local operator accounts and OIDC email allowlist
  (`admin create|disable|role|allow-email|list|bootstrap-token`), with hashed
  passwords, sessions, and CSRF for the management UI (`@shm/auth`).
- **Web UI** — a localhost Vite **React SPA** plus a Node **BFF**: an install
  wizard (bootstrap mode, self-locking after install), an operations console
  (persistent mode), and operator login. The SPA is built on **React 19**,
  **Mantine 9**, **Tailwind 4**, and **@tanstack/react-query**, aligned with
  `sh-selfhelp_frontend`. The BFF binds to `127.0.0.1` by default, with a
  Host-header (DNS-rebinding) guard and session+CSRF auth in persistent mode.

### Security

- Ed25519-signed, SHA-256-checksummed releases verified against a trusted-keys
  file; unsigned/untrusted/`dev`-keyed releases refused in production.
- Canonical JSON byte-compatible with the registry signer and the host PHP
  `SignedPayloadBuilder`.
- No runtime container mounts the Docker socket (only the shared Traefik proxy,
  read-only), enforced by `@shm/docker` guards.
- `docker compose down -v` and MySQL-volume deletion are blocked; instance data
  survives updates and non-destructive removals.
- Support bundles are redacted and re-scanned for residual secrets before being
  written.

### Documentation

- Added the `docs/` tree: architecture, developer guide, release & publishing,
  and operator runbooks (install, update, backup-restore, clone-remove,
  safe-mode-and-recovery, support-bundle, security-hardening).
- Added `AGENTS.md` (repository contract) and this changelog.
