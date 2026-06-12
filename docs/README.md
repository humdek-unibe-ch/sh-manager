# SelfHelp Manager documentation

Audience: Developers and server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`, manages the SelfHelp 0.x pre-release platform line)
Last verified: 2026-06-12
Source of truth: `apps/`, `packages/`, and `README.md` in this repository

This is the documentation entrypoint for **SelfHelp Manager** — the official
Docker-only, connected installer, updater, and multi-instance server manager for
SelfHelp. The top-level [`README.md`](../README.md) is the quick-start; the pages
below go deeper.

## For developers

- [Architecture](architecture.md) — monorepo layout, the package graph, the
  pure-core / injected-boundary design, the CLI, and the web UI + local BFF.
- [Developer guide](developer-guide.md) — environment setup, commands, the test
  strategy, the web UI stack (React 19 + Mantine + Tailwind + React Query), and
  how to add a package or a wizard step.
- [Release & publishing](release-publishing.md) — how the manager and the
  artifacts it installs are versioned, signed, and published to the registry.
- [Distribution architecture audit & test-coverage matrix](distribution-architecture-audit-and-coverage.md)
  — the audit of the publish/install/update pipeline and the scenario → test map
  (covered / new / nightly) across all five repos.

## For operators

Task-based runbooks live under [`operator/`](operator/).

**Start here** for the whole picture:

- [Operations runbook (end to end)](operator/operations-runbook.md) — the single
  walkthrough of the full lifecycle: install → configure → operate → update →
  back up → recover.
- [Quick reference](operator/quick-reference.md) — the command cheat-sheet for
  common daily tasks (health, logs, restart, update, backup).
- [Post-install checklist](operator/post-install-checklist.md) — what to do right
  after a successful install (secrets, access, backups, monitoring).
- [Troubleshooting](operator/troubleshooting.md) — symptom → cause → fix
  (won't start, DNS/TLS, ports, disk space, updates, 503, health).

**Task runbooks:**

- [Install](operator/install.md) — bootstrap a server and install the first
  instance, via the web wizard or the CLI.
- [GUI instance management](operator/gui-instance-management.md) — manage the
  full instance lifecycle from the persistent web UI: health, backups, update
  dry-run + execute, restore, clone, change address, remove, live operation
  logs, and the automatic CMS-operations drain loop.
- [Domains, DNS and local ports](operator/domains-and-ports.md) — set up DNS
  for a production instance and change an instance's domain or localhost port
  later (GUI dialog or `sh-manager instance set-address`).
- [Windows quickstart](operator/windows-quickstart.md) — test the whole story
  on Windows + Docker Desktop using only the published manager image: local
  mode on ports (no domains/SSL), multiple side-by-side instances, the GUI,
  CMS testing, and updates.
- [Update](operator/update.md) — dry-run, preflight, and apply an instance
  update (backup-first, rollback-on-failure).
- [Backup & restore](operator/backup-restore.md) — create checksummed backups
  and restore them (same-instance or as a clone).
- [Clone & remove](operator/clone-remove.md) — copy an instance with fresh
  secrets, and disable / remove / fully delete an instance.
- [Safe mode & recovery](operator/safe-mode-and-recovery.md) — plugin safe-mode
  and how to recover a broken instance.
- [Support bundle](operator/support-bundle.md) — collect a redacted diagnostics
  bundle to share with support.
- [Security hardening](operator/security-hardening.md) — the security model and
  the checklist for a production server.
- [Rehearse publish/install/update](operator/rehearsal-publish-install-update.md)
  — a safe, disposable `test`-channel rehearsal of the whole pipeline (build test
  images → serve a dev-signed registry → install → update via manager and CMS →
  backup/restore/clone/rollback), automated as `SHM_E2E=1 npm run e2e`.
- [Local Windows walkthrough](operator/local-windows-walkthrough.md) — the
  beginner-friendly, copy-paste version of the rehearsal for Windows + Docker
  Desktop: install the manager, install an instance with the GUI wizard,
  publish a small update to a local test registry, update via manager and CMS.

## Conventions

- The manager is **Docker-only and connected**: it never compiles on the server,
  it pulls **signed** artifacts from the **one** official registry.
- `sh-manager` is the only component allowed to talk to Docker. The CMS never
  controls Docker directly.
- No runtime container mounts the Docker socket (only the shared Traefik proxy,
  read-only).
- Instance data (database, uploads, plugin artifacts, secrets, backups, logs)
  **survives** updates and removals unless an explicit, confirmed full delete is
  requested.
