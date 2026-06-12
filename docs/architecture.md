# Architecture

Audience: Developers
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`)
Last verified: 2026-06-08
Source of truth: `packages/*/src`, `apps/cli/src`, `apps/web/src`

## Overview

SelfHelp Manager is an **npm-workspaces TypeScript monorepo**. It has two
deliverables that share the same package graph:

- **`apps/cli`** — the `sh-manager` command-line tool (the canonical interface).
- **`apps/web`** — a localhost web UI: a Vite **React SPA** plus a small Node
  **BFF** (backend-for-frontend) that wraps the exact same CLI actions.

Both call the same `packages/*` logic, so the web UI can never drift from the
CLI: it is a presentation layer over identical behaviour.

## Design principle: pure core, injected boundaries

All **decision logic is pure and unit-tested**. Every side effect — Docker,
network, filesystem, DNS — lives behind an **injected boundary** (an interface
passed in as a dependency). This is why the whole suite runs offline with no
Docker daemon, no registry, and no network:

- The pure logic lives in `packages/*` and in `apps/cli/src/actions.ts`.
- The real, side-effecting implementations live in `apps/cli/src/env.ts`
  (`realDeps`) — the Docker Compose runner, the HTTP registry fetcher, image
  digest resolution, health probing, host resource probing, DNS resolution.
- Tests inject in-memory fakes for those boundaries.

```
sh-manager (CLI)            sh-manager-web (BFF)
        \                         /
         \                       /
          v                     v
   apps/cli/src/actions.ts  (pure orchestration)
                  |
                  v
            packages/*  (pure decision logic)
                  ^
                  |  (injected at the edge only)
   apps/cli/src/env.ts realDeps -> Docker / HTTP / FS / DNS
```

## Package graph

| Package | Responsibility |
| --- | --- |
| `@shm/schemas` | Types, JSON Schemas, schema-version gating, validators (`validateTrustedKeys`, registry/manifest/lock schemas). |
| `@shm/registry` | Canonical JSON, Ed25519 signature verification, SHA-256 checksums, the registry client. Byte-compatible with the registry signer and the host PHP `SignedPayloadBuilder`. |
| `@shm/resolver` | Semver resolution, security **advisories**, and core ⇄ frontend ⇄ plugin ⇄ plugin-API compatibility. |
| `@shm/docker` | Per-instance Docker Compose generation, `.env` (non-secret BFF invariant), **safety guards**, the compose runner interface. |
| `@shm/traefik` | The single shared reverse proxy (the only container with the Docker socket, read-only). |
| `@shm/instances` | Path layout, **atomic writes**, inventory/manifest/lock stores, drift detection, operator README generation, secrets, remove. |
| `@shm/core` | Instance-scope guard, preflight, health, update plan/execute, bootstrap/install orchestration, post-up provisioning. |
| `@shm/backup` | Backup manifest + integrity (checksums), restore/clone planning + secret policy. |
| `@shm/support` | Secret redaction + support-bundle assembly (re-scanned for residual secrets). |
| `@shm/auth` | Configurable local + campus/OIDC operator authorization, sessions, CSRF, password hashing, operator store. |
| `apps/cli` | `sh-manager` command-line entrypoint + real boundary implementations. |
| `apps/web` | `sh-manager-web` localhost BFF + the React SPA. |

## The web UI and the local BFF

The web UI is a **Vite SPA + Node BFF**, intentionally **not** Next.js. It is a
local/admin tool, so server-side rendering, edge routing, and a heavy framework
would add cost without benefit.

### Tech stack (aligned with `sh-selfhelp_frontend`)

- **React 19**
- **Mantine 9** (`@mantine/core`, `@mantine/hooks`, `@mantine/notifications`)
- **Tailwind 4** via `@tailwindcss/postcss` + `tailwind-preset-mantine`, layered
  with `@layer theme, base, mantine, components, utilities;` (mirrors the
  frontend's `globals.css`)
- **`@tanstack/react-query`** for all BFF calls (queries + mutations)
- **Vite** for dev/build, **Vitest + Testing Library** for tests

Custom CSS is a last resort; components are Mantine + Tailwind utilities.

### The BFF (`apps/web/src/server.ts`)

The BFF is a Node-built-ins HTTP server. Its only job is to expose the CLI
actions as a tiny JSON API to the SPA, with the security posture a local admin
tool needs:

- Binds to **`127.0.0.1`** by default. A non-loopback bind is **refused** unless
  the operator explicitly opts in (`--allow-non-local`).
- A **Host-header allowlist** defends against DNS-rebinding (returns `421`
  otherwise).
- Every API route requires an authenticated operator **session**, with **CSRF**
  (`x-shm-csrf` header) on state-changing requests. The session cookie is
  `shm_session` (`HttpOnly; SameSite=Strict`).
- One pre-auth exception: `POST /api/setup/operator` creates the **first**
  operator account. It is localhost-only and rejected with `403` as soon as
  any operator exists.
- The static SPA shell + hashed assets are always served (they contain no
  secrets) so the sign-in screen can load before authentication.

JSON API surface (all under `/api`): auth (`login`/`logout`/`meta`,
`setup/operator`), server (`status`, `preflight`), instances (CRUD, health,
backups, restore, update dry-run/execute, clone, address, mailer, remove),
operations (history + journaled logs), and registry version listings — see
[GUI instance management](operator/gui-instance-management.md) for the
endpoint table.

The SPA talks to this API through one typed client
(`apps/web/src/ui/lib/api-client.ts`), which captures the CSRF token on
login/first-operator setup and replays it on every later state-changing
request, and turns non-2xx responses into a typed `ApiError` (status + human
message) for friendly UI.

### Dev vs. production wiring

- **Dev**: run the BFF (`sh-manager-web`, default `http://127.0.0.1:8765`) and
  the Vite dev server (`:5173`). Vite proxies `/api` to the BFF
  (`SHM_WEB_API`, default `http://127.0.0.1:8765`).
- **Production**: build the SPA to `dist-web`, then run `sh-manager-web`; the BFF
  serves the built SPA from `--client-dir` (default `dist-web`) and the `/api`
  routes from the same origin. If the build is missing, the BFF falls back to a
  minimal inline shell.

## CMS / manager boundary (instance-scoped)

The Symfony CMS never controls Docker. When an instance needs an update it
records an **instance-scoped** operation; the manager claims and executes it via
`sh-manager instance process-operations <id> --backend-url ... --token ...`. The
backend never trusts a browser-provided `instanceId`; cross-instance attempts
are denied and logged (`CrossInstanceError`). Per-instance manager tokens
authenticate the manager to a single instance's backend.

## Safety invariants (enforced in code + tests)

- Production is Docker-only and connected — no `npm build` / `composer install`
  on the server; only signed artifacts are pulled.
- Exactly **one** official registry.
- **No runtime container mounts the Docker socket** (only the shared Traefik
  proxy, read-only) — enforced by `@shm/docker` guards.
- `docker compose down -v` and MySQL-volume deletion are blocked; DB, uploads,
  plugin artifacts, secrets, backups, and logs survive updates.
- Releases are Ed25519-signed + SHA-256-checksummed; unsigned / untrusted /
  `dev`-keyed releases are refused in production.
