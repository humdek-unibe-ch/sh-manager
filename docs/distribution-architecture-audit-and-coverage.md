# Distribution architecture audit and test-coverage matrix

Audience: Developers and release engineers
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`) and the SelfHelp 0.x pre-release distribution across `sh-selfhelp_backend`, `sh-selfhelp_frontend`, `sh-selfhelp_shared`, and `sh2-plugin-registry`
Last verified: 2026-06-09
Source of truth: the test files cited below, and `sh-selfhelp_backend/docs/archive/core-installation-and-distribution-plan.md` ("Testing And Verification Plan", lines 2972–3120)

This page does two things:

1. A short **architecture audit** of the publish → install → update →
   backup/restore/clone/rollback pipeline — what is sound, what the gaps were, and
   how they were closed.
2. A **coverage matrix** that maps every scenario in the archived plan's *Testing
   And Verification Plan* to the test(s) that cover it, marking each as
   **covered** (pre-existing), **new** (added in this workstream), or **nightly**
   (the heavy real-Docker e2e, off the PR gate).

## Architecture audit

The distribution architecture is **sound and unchanged** by this workstream. The
manager stays the only Docker-touching component; the CMS only ever records an
**instance-scoped** request and the manager claims/executes it; releases are
**canonical-JSON + Ed25519 signed** and verified everywhere; instance data lives
in **persistent volumes** that survive updates/removals; and the registry is the
single signed source of truth for versions, compatibility, and advisories.

The gaps were **operability and provability**, not design:

- No safe way to rehearse the full pipeline end to end without the public
  registry / production key. → Added the **`test` channel** (additive enum across
  manager `@shm/schemas` + the registry schemas), the **e2e harness**
  (`e2e/build-images.mjs`, `e2e/build-test-registry.mjs`, `e2e/serve-registry.mjs`),
  and the **real Docker e2e** (`e2e/docker-e2e.test.ts`).
- No scripted, reviewed real-public publish. → Added the registry
  `scripts/assemble-release.mjs` + the **reviewed** `publish-core-release.yml`
  (assemble → sign with the production key → open a PR; never auto-merges).
- Thin proof at the seams: backend manager-loop persistence, the admin update UI,
  and shared contract types. → Added a backend **integration round-trip** + a
  **manager-route security** test, a **frontend** component test, and **shared**
  type + schema-parity coverage.
- Sparse operator docs for the risky flows. → Added the
  [rehearsal runbook](operator/rehearsal-publish-install-update.md), the
  real-public runbook (registry `docs/operations/publishing.md`), and this matrix.

Residual, intentional risks: the heavy e2e is **off the PR gate** (Docker +
multi-repo checkout, ~15–20 min) and runs nightly / on demand; and until the
**production signing key** is wired, platform releases stay on the `test` channel
and plugin entries stay `untrusted` (the publish workflow refuses to dev-sign a
non-`test` channel).

## Legend

- **Covered** — pre-existing automated test continues to cover this.
- **New** — test added in this workstream.
- **Nightly** — covered by the real-Docker e2e (`SHM_E2E=1 npm run e2e`,
  `.github/workflows/e2e-docker.yml`); not on the PR gate.

Paths are relative to the repository named in the row (manager paths have no
prefix; other repos are prefixed, e.g. `backend:`).

## Installer

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Connected registry fetch succeeds and verifies signature; unknown source rejected in prod; dev-keyed rejected in prod | `packages/registry/src/client.test.ts`, `packages/registry/src/signature.test.ts`, `packages/registry/src/fixtures-e2e.test.ts` | Covered |
| Missing internet / registry unavailable blocks fresh install with a clear, retryable error | `packages/core/src/preflight.test.ts`, `apps/cli/src/smoke.test.ts` | Covered |
| Production domain duplicate rejected; inventory prevents duplicate domains | `packages/instances/src/domain.test.ts`, `packages/instances/src/stores.test.ts` | Covered |
| Local mode: two instances on different localhost ports; Mailpit default, no real outbound | `packages/docker/src/compose.test.ts`, `packages/docker/src/env.test.ts`; end-to-end in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Production mode requires real domain + ports 80/443; installer binds localhost; self-disables after success | `apps/web/src/wizard.test.ts`, `apps/web/src/server.test.ts`, `packages/core/src/bootstrap.test.ts` | Covered |
| Generated compose includes log rotation for every long-running container | `packages/docker/src/compose.test.ts` | Covered |
| Full fresh install + provision, then HTTP `/cms-api/v1/health` + admin login | `e2e/docker-e2e.test.ts` | Nightly |

## Manager web UI auth (persistent mode)

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Web UI disabled by default; localhost/VPN/private-network bind; login required | `apps/web/src/server.test.ts`, `packages/auth/src/session.test.ts` | Covered |
| Local-auth passwords hashed, never in `.env`; bootstrap token one-time + rotates | `packages/auth/src/password.test.ts`, `packages/auth/src/storage.test.ts`, `packages/auth/src/auth.test.ts` | Covered |
| Campus login disabled by default; only configured mappings become operators; unauthorized rejected | `packages/auth/src/oidc.test.ts`, `packages/auth/src/operators.test.ts` | Covered |

## Multi-instance

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Separate Docker projects, DB volumes, Redis, Mercure secrets, JWT keys + `APP_SECRET`; only proxy shared | `packages/instances/src/secrets.test.ts`, `packages/docker/src/compose.test.ts`, `packages/traefik/src/proxy.test.ts`; live in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Two instances run different backend/frontend versions; domain routes to the right frontend; backend not publicly exposed | `packages/resolver/src/core.test.ts`, `packages/docker/src/compose.test.ts`; live in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Server inventory lists every instance | `packages/instances/src/stores.test.ts` | Covered |

## Remove-instance

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| `disable` keeps data; `remove_containers_keep_data` keeps volumes/backups; `full_delete` requires typed confirm + only then deletes selected volumes | `packages/instances/src/remove.test.ts`; live in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Shared Traefik not removed while another instance exists; id/path/domain mismatch blocks destructive delete; inventory updated | `packages/instances/src/remove.test.ts`, `packages/traefik/src/proxy.test.ts` | Covered |

## Restore

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Selects a backup + verifies integrity; refuses on missing/failed signature/checksum | `packages/backup/src/backup.test.ts` | Covered |
| Same-instance restore preserves secrets/identity; restores DB + uploads + plugin artifacts + manifest + lock | `packages/backup/src/backup.test.ts`; live in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Restore-as-clone generates new secrets + isolated Docker state; runs migrations only when required; health-checks after | `packages/backup/src/backup.test.ts` | Covered |

## Clone

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| New id + new domain/port; copies DB/uploads/plugin artifacts; preserves source-lock versions | `packages/backup/src/backup.test.ts`; live in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Fresh `APP_SECRET`/JWT/Mercure/DB/Redis secrets; new project/networks/volumes/manifest/lock; inventory updated; **source untouched** | `packages/instances/src/secrets.test.ts`, `packages/backup/src/backup.test.ts`; source-untouched asserted in `e2e/docker-e2e.test.ts` | Covered + Nightly |

## Docker host access and instance scoping

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Only the manager touches Docker; no runtime container mounts the Docker socket | `packages/docker/src/guards.test.ts`, `packages/docker/src/compose.test.ts` | Covered |
| Manager rejects unknown / mismatched instance ids; rejects + logs CMS cross-instance update requests | `packages/core/src/instance-scope.test.ts`, `packages/core/src/operations.test.ts` | Covered |
| Backend derives instance id server-side; ignores/rejects browser `instanceId`; cross-instance denied (DB-backed + HTTP) | `backend: tests/Unit/Service/System/SystemUpdateServiceManagerLoopTest.php`, `backend: tests/Integration/Service/System/SystemUpdateManagerLoopRoundTripTest.php`, `backend: tests/Controller/Api/V1/Manager/SystemManagerControllerSecurityTest.php` | Covered + New |
| Manager API not reachable through public instance routes; manager token gates the loop routes (public, not ACL) | `backend: tests/Controller/Api/V1/Manager/SystemManagerControllerSecurityTest.php`, `backend: tests/Unit/Controller/Api/V1/Manager/SystemManagerControllerTest.php` | New + Covered |

## Registry / resolver

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Unknown major schema version rejected; compatible minor additions tolerated; `requiresManager` produces a clear manager-update instruction | `packages/schemas/src/validate.test.ts`, `packages/schemas/src/version.test.ts` | Covered |
| `test` channel is a valid, additive channel across all release schemas | `packages/schemas/src/validate.test.ts`, `e2e/harness.test.ts`; `registry: scripts/assemble-release.test.mjs`, `registry: npm run validate:unified` | New |
| Latest/specific core selected; latest-compatible vs specific plugin; security-blocked refused; destructive migration forces backup + manual confirm | `packages/resolver/src/core.test.ts`, `packages/resolver/src/plugins.test.ts` | Covered |
| Registry unavailable degrades update/plugin checks gracefully (existing instances keep running) | `packages/core/src/preflight.test.ts`; backend advisories degrade offline in `backend: tests/Unit/Service/System/SystemAdvisoryServiceTest.php` | Covered |
| Assembled release docs are schema-valid + signature-verifiable | `registry: scripts/assemble-release.test.mjs`, `registry: scripts/registry-publish.test.mjs`, `e2e/harness.test.ts` | New |

## Update

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Dry run changes nothing; preflight reports plugin incompatibility / image unavailable; verifies signatures+checksums | `packages/core/src/preflight.test.ts`, `packages/core/src/update.test.ts` | Covered |
| Automatic rollback before migrations; destructive path needs verified backup + manual confirm; manifest+lock updated atomically; lock drift detected | `packages/core/src/update.test.ts`, `packages/instances/src/drift.test.ts`; rollback live in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Updates preserve DB/uploads/plugin artifacts/secrets/backups/logs; MySQL image update reuses the existing data volume + requires backup/compat/health | `packages/core/src/update.test.ts`; MySQL-volume-preserved asserted in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| CMS requests/monitors status without mutating Docker; the manager loop persists requested → claim → status → succeeded/failed; terminal guard | `packages/core/src/operations.test.ts`, `apps/cli/src/operations-client.test.ts`; `backend: tests/Integration/Service/System/SystemUpdateManagerLoopRoundTripTest.php`; CMS-loop live in `e2e/docker-e2e.test.ts` | Covered + New + Nightly |
| Backend rollback policy (pre/post-migration) | `backend: tests/Unit/Service/System/SystemUpdateServiceRollbackPolicyTest.php` | Covered |

## Backup

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Backup writes under the instance `backups/`; includes MySQL dump + uploads + plugin artifacts + identity/lock/compose + redacted metadata + checksum manifest | `packages/backup/src/backup.test.ts`; live in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Integrity verification fails on missing/invalid checksums; redacted metadata never stores secrets | `packages/backup/src/backup.test.ts` | Covered |

## Persistent state

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| DB/uploads/plugin artifacts in per-instance volumes; backend/frontend/worker/scheduler containers disposable; uploads not only inside container FS | `packages/docker/src/compose.test.ts`; preserved-across-update in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Full delete removes persistent state only after explicit confirmation; operation logs persisted | `packages/instances/src/remove.test.ts`, `packages/core/src/operations.test.ts` | Covered |

## Health / support

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Health aggregates frontend/backend/DB/Redis/Mercure/scheduler/worker/plugin state | `packages/core/src/health.test.ts`; `backend: tests/Unit/Service/System/SystemHealthServiceTest.php`; live probe in `e2e/docker-e2e.test.ts` | Covered + Nightly |
| Support bundle redacts secrets; safe mode disables a broken plugin | `packages/support/src/support.test.ts`, `packages/core/src/bootstrap-safety.test.ts` | Covered |

## Frontend / BFF

| Scenario(s) | Test(s) | Status |
| --- | --- | --- |
| Admin system page shows update + compatibility/advisory warnings; advisories degrade when the registry is offline | `frontend: src/app/components/cms/system/system-maintenance-page/__tests__/SystemMaintenancePage.test.tsx` | New |
| Admin update UI is instance-scoped and never sends a browser `instanceId` for execution | `frontend: src/app/components/cms/system/system-maintenance-page/__tests__/SystemMaintenancePage.test.tsx` | New |
| System request/response contracts (incl. advisories) stay in sync backend ⇄ shared | `shared: src/types/api/__tests__/system.test.ts`, `shared: scripts/check-schema-parity.mjs` | New |

## How to run

- **PR gate (fast, offline)** — per repo:
  - manager: `npm run check` (typecheck + lint + test + schema validation), `npm run smoke`.
  - backend: `composer phpstan` (0 errors) + the focused PHPUnit files; the
    `security` group runs the manager-loop integration + manager-route tests.
  - frontend / shared: `npx vitest run <file>` for the touched specs;
    shared `node scripts/check-schema-parity.mjs`.
  - registry: `npm run validate:unified`, `npm run guard:trust`, `npm test`.
- **Nightly / on demand (heavy)** — `SHM_E2E=1 npm run e2e` (Docker + sibling
  backend/frontend checkouts), or the `manager-e2e-docker` workflow
  (`.github/workflows/e2e-docker.yml`). The same journey is a copy-paste runbook
  in [operator/rehearsal-publish-install-update.md](operator/rehearsal-publish-install-update.md).

## Related

- [Release & publishing](release-publishing.md) — real-public vs rehearsal paths.
- [Rehearse publish/install/update](operator/rehearsal-publish-install-update.md).
- `sh-selfhelp_backend/docs/developer/25-instance-scoped-system-layer.md` — the
  backend system layer + manager loop.
- `sh-selfhelp_frontend/docs/developer/system-maintenance-admin.md` — the admin
  update/maintenance UI.
- `sh2-plugin-registry/docs/operations/publishing.md` — signing + publishing.
