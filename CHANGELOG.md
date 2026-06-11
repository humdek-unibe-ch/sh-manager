# Changelog

All notable changes to **SelfHelp Manager** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

The manager has two version axes (see
[docs/release-publishing.md](docs/release-publishing.md)):

- **The manager tool** uses its own semver (currently `0.1.5`). Registry releases
  declare a `requiresManager` constraint, so the tool version is a compatibility
  contract.
- **The SelfHelp platform** it installs/updates is currently the pre-release
  **`0.x`** line (core, frontend, scheduler, worker — all `0.1.0`).

A single manager `0.1.0` installs and manages SelfHelp `0.x` pre-release instances.

## [Unreleased]

## [0.1.5] - 2026-06-11

Windows-simplification release: mount any state folder, no Docker Desktop VM
paths, and the image distributes its own wrapper script.

### Added
- **Engine-side path auto-discovery** — when the manager runs containerized,
  it inspects its own container through the mounted socket and learns where
  the Docker ENGINE sees the state root. Generated compose bind sources
  (instance JWT keys, proxy Let's Encrypt storage) and backup/restore helper
  mounts are translated automatically. The state folder can now be mounted
  from anywhere (`-v D:\selfhelp:/opt/selfhelp` on Windows,
  `-v /home/me/selfhelp:/opt/selfhelp` on Linux) — the previous
  same-path-on-both-sides requirement and the Windows
  `/run/desktop/mnt/host/…` VM-path trick are gone. Same-path mounts (the
  documented Linux production layout) discover an identity mapping and keep
  emitting today's relative binds — zero behavior change. Escape hatch:
  `SELFHELP_ENGINE_ROOT=<path|off>`.
- **`sh-manager wrapper --shell powershell|bash`** — prints a small `shm`
  wrapper script so the image distributes its own convenience layer
  (`docker run --rm … wrapper --shell powershell > shm.ps1`). The script
  mounts the socket + state folder (default: the folder the script is saved
  in), forwards every command, publishes the GUI loopback-only for
  `shm web` (`--web-port`, default 8765), survives Git Bash path mangling
  (`cygpath` + `MSYS_NO_PATHCONV`), and supports `--state-root`/`--image`
  overrides.

### Changed
- **`instance install --registry` is now optional** and defaults to the
  official registry (`https://humdek-unibe-ch.github.io/sh2-plugin-registry/`),
  matching the web wizard. Release signature/checksum verification against the
  pinned trusted keys is unaffected by the registry URL.
- **Windows quickstart rewritten** around the generated wrapper: pull →
  generate `shm.ps1` → `server init` → `instance install` → `shm web`, with
  PowerShell as the primary shell and no manual path translation anywhere.
  `install.md`, `quick-reference.md`, and the README follow the new flow, and
  the "not initialized" CLI hint now points at the wrapper.

## [0.1.4] - 2026-06-10

Windows-testing + self-update release: the Docker image is now first-class on
Docker Desktop (Windows/macOS), `server init` actually brings the shared proxy
up, and both the CLI and the GUI can tell you when a newer manager is released.

### Added
- **`sh-manager self-update`** — checks the official GitHub releases feed and
  prints the exact update commands for the detected runtime (Docker image →
  `docker pull …`, source checkout → `git pull && npm ci && npm run build`).
  Exit code `2` means "update available" so cron/scripts can branch on it.
  Network failures degrade to a clear message, never a crash.
- **GUI update visibility** — the persistent operations console now shows a
  "Manager version" card with the installed version, an "Up to date /
  Update available" badge, release-notes link, and the copy-paste update
  commands (`GET /api/manager/update-check` on the manager BFF).
- **`server init` now creates the shared proxy network** (`selfhelp_proxy`)
  idempotently and, in production mode, starts the Traefik proxy container —
  previously the first `instance install --up` failed with "network declared
  as external, but could not be found" unless the operator created it by hand.
  `instance install --up` also re-ensures the network for servers bootstrapped
  by older managers. Local mode creates the network but starts no proxy (no
  80/443 grab on dev machines).
- **Containerised health probes work on Docker Desktop** — when the manager
  runs inside a container, health probes against `http://localhost:<port>`
  (local-mode instances publish on the host) are rewritten to
  `host.docker.internal` automatically. Override or disable with
  `SELFHELP_LOCALHOST_PROBE_HOST` (plain Linux engines:
  `--add-host=host.docker.internal:host-gateway`).
- **`sh-manager web`** — the web UI (install wizard / operations console) is
  now a first-class CLI subcommand, so the published Docker image can serve
  the GUI directly:
  `docker run -p 127.0.0.1:8765:8765 … sh-manager:latest web --host 0.0.0.0`.
  `sh-manager-web` still works and now shares the same composition root
  (`apps/web/src/main.ts`).
- **Windows quickstart** (`docs/operator/windows-quickstart.md`) — copy-paste
  path from a fresh Docker Desktop to a running local instance using only the
  published image (no Node/git), including the Git Bash `MSYS_NO_PATHCONV`
  path-mangling fix, Docker Desktop path-parity root, multi-instance port
  layout, and the GUI/CMS/update walkthrough.

### Changed
- **Single source of truth for the manager version**: `MANAGER_VERSION` lives
  in `@shm/schemas` (`packages/schemas/src/version.ts`) and the CLI
  (`--version`), web UI, and inventory stamps all import it. A release now
  bumps two files (that constant + root `package.json`) instead of five.
- The "server not initialized" CLI hint now also explains the local mode
  variant and the Docker named-volume/`MSYS_NO_PATHCONV` pitfalls on Windows.

## [0.1.3] - 2026-06-10

The first actually *runnable* Docker image. `v0.1.1` built and pushed fine but
every container invocation died at startup (see Fixed). The interim `v0.1.2`
tag never produced an image either: its new build step crashed on CI's Node
(`import { console } from 'node:console'` is not a named export there), so the
release failed at the image build — fixed here by writing to
`process.stdout` instead.

### Fixed
- **Docker image was unusable** — any command (`instance list`, `--help`, the
  GUI) failed at startup with
  `ENOENT ... /app/dist/packages/schemas/examples/trusted-keys.json`. The
  compiled bins resolve their default trusted-keys file relative to
  `dist/apps/.../bin.js`, i.e. *inside* `dist/`, but the image copied the JSON
  assets next to `dist/` instead. `npm run build` now copies
  `packages/schemas/{keys,examples}` into `dist/` (`scripts/copy-dist-assets.mjs`),
  so the compiled tree is self-contained everywhere, not only in Docker.

### Security
- **The default trust anchor is now the pinned official production key**
  (`packages/schemas/keys/official-trusted-keys.json`, keyId `prod`) for both
  the CLI and the web UI. Previously the default pointed at the *dev fixture*
  keys (`packages/schemas/examples/trusted-keys.json`), whose private seed is
  public in this repo — an operator relying on the default would have accepted
  attacker-signed "releases". The dev fixture now has to be opted into
  explicitly via `SELFHELP_TRUSTED_KEYS`/`--trusted-keys` (tests and local
  rehearsals already do).

### Added
- **MPL-2.0 `LICENSE` file** at the repo root (the `package.json` already
  declared `MPL-2.0`; now the license text ships with the repo and image, like
  the other SelfHelp repositories).
- **`npm run headers:check`** (`scripts/check-spdx-headers.mts`) — CI-enforced
  gate (part of `npm run check`) that every tracked source file carries the
  MPL-2.0 SPDX header, mirroring the backend's `composer headers:check`.

## [0.1.1] - 2026-06-10

First release whose Docker image actually shipped — the `v0.1.0` tag never
produced an image because the release workflow failed before its first step
(see Fixed below).

### Added
- **Local Windows walkthrough** (`docs/operator/local-windows-walkthrough.md`):
  beginner-friendly, copy-paste guide for Windows + Docker Desktop — install the
  manager from source, install an instance with the GUI wizard and the CLI,
  publish a small update to a local dev-signed test registry, then update the
  instance via the manager and via the CMS request flow.

### Fixed
- **`manager-release` workflow could not run at all**: `aquasecurity/trivy-action`
  was pinned to the mutable `0.28.0` tag, which was deleted upstream after the
  March 2026 Trivy supply-chain compromise (GHSA-69fq-xp46-6x23), so GitHub
  failed the run at action-resolution time ("unable to find version 0.28.0").
  The action is now SHA-pinned to the immutable `0.35.0` release commit, the
  SARIF upload got the missing `security-events: write` permission, moved to
  `codeql-action/upload-sarif@v4` (v3 is deprecated December 2026), and is
  `continue-on-error` so an advisory upload can never block a tag release.
- Generated instance `.env` files now emit the version env names the backend
  actually reads: `SELFHELP_CMS_VERSION` (was the unconsumed `SELFHELP_VERSION`)
  and the new `SELFHELP_FRONTEND_VERSION` (deployed frontend image version).
  Without these the CMS admin system page reported the image's baked default and
  `Frontend: unknown` on managed installs.

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
