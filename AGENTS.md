<!--
SPDX-FileCopyrightText: 2026 Humdek, University of Bern
SPDX-License-Identifier: MPL-2.0
-->

# AGENTS.md

Before returning anything print in chat `❤️AGENTS.md` so that we know the rules are used

## Project Overview

`@selfhelp/manager` (the **SelfHelp Manager**, CLI `sh-manager`) is the official **Docker-only, connected** installer, updater, and multi-instance server manager for the SelfHelp platform. It is the only supported way to install and operate SelfHelp in production.

It does the following on a single server:

- Bootstraps a server: validates Docker/Compose, connectivity and resources, then creates the shared reverse proxy (Traefik) and the install root layout.
- Resolves and verifies official releases against the **signed, trusted registry** (Ed25519 signatures + SHA-256 checksums) before anything is pulled.
- Creates and manages isolated SelfHelp **instances** (each its own Compose project, network, volumes, secrets, manifest and lock file).
- Runs updates with dry-run/preflight/execute, backup/restore, clone/remove, support bundles, safe-mode recovery, and health checks.
- Ships a small **local web UI** (Vite SPA + a Node BFF) for the guided install wizard and an operations console, reachable from the server only.

This repository is **not** a SelfHelp backend, frontend, or plugin. It orchestrates Docker and the registry; it does not contain Symfony/PHP, Next.js page rendering, or CMS code. When manager behavior depends on backend/frontend/registry contracts, check those repos first.

## Tech Stack

- TypeScript (strict), Node.js `>=22`, ESM-only (`"type": "module"`).
- npm **workspaces** monorepo: `packages/*` (domain libraries) + `apps/*` (CLI + web UI).
- `commander` for the CLI; `yaml` for Compose/manifest IO; `tweetnacl` for Ed25519 verification; `ajv` + `ajv-formats` for JSON Schema validation; `semver` for compatibility/resolver logic.
- Docker Engine + Compose v2 are runtime dependencies of the *managed server*, never of the unit test suite.
- Web UI (in `apps/web`): **Vite SPA + Node BFF**, aligned with `sh-selfhelp_frontend`'s component stack so the two are maintained the same way:
  - React 19, `@mantine/core` / `@mantine/hooks` / `@mantine/notifications` (Mantine 9).
  - Tailwind CSS 4 via `@tailwindcss/postcss` + the shared `tailwind-preset-mantine` integration.
  - `@tanstack/react-query` for BFF/API calls.
  - The web UI stays a **Vite SPA**, not Next.js — it is a local/admin tool, not a public site.
- Vitest for unit + web UI tests (`jsdom` for `.tsx`, node for packages); ESLint (flat config) + `typescript-eslint`.
- License headers are SPDX (`MPL-2.0`): `// SPDX-…` for source, `<!-- … -->` for Markdown, `# …` for YAML.

## Repository Structure

- `packages/schemas` — JSON Schemas + TS types for the registry, manifests, lock files, server inventory; `@shm/schemas`.
- `packages/registry` — registry fetch, canonical payload hashing, checksum + Ed25519 signature verification, trusted-keys handling; `@shm/registry`.
- `packages/resolver` — version/compatibility resolution, channel selection, advisory filtering, `requiresManager` gating; `@shm/resolver`.
- `packages/docker` — Compose file/env generation, Docker invocation, and the safety guard that forbids dangerous flags; `@shm/docker`.
- `packages/traefik` — shared reverse-proxy configuration; `@shm/traefik`.
- `packages/instances` — instance manifest/lock atomic writes, server inventory, instance directory layout; `@shm/instances`.
- `packages/core` — orchestration that composes the other packages (install/update/lifecycle); `@shm/core`.
- `packages/backup` — backup/restore + integrity; `@shm/backup`.
- `packages/support` — support-bundle generation + secret redaction; `@shm/support`.
- `packages/auth` — operator auth: local accounts (email + password), roles, sessions, CSRF, password hashing; `@shm/auth`. Auth is local-only (remote access via SSH tunnel); there is no campus/OIDC/SSO login.
- `apps/cli` — the `sh-manager` CLI (`server`, `instance`, `admin`, `doctor`, …); entry `apps/cli/src/bin.ts`.
- `apps/web` — the local web UI:
  - `apps/web/src/server.ts` + `apps/web/src/bin.ts` — the **BFF** (serves the SPA from `dist-web/` and exposes `/api/*`).
  - `apps/web/src/wizard.ts` + `apps/web/src/actions.ts` — server-authoritative wizard state machine + install/health actions (single source of truth for steps + validation).
  - `apps/web/src/ui/**` — the React SPA (`components/` design-system wrappers on Mantine, `features/`, `hooks/`, `lib/`, `test/`).
- `scripts/` — `validate-schemas.mts`, `sign-fixtures.mts`, `license-report.mts`.
- `docs/` — architecture, developer guide, operator runbooks, release/publishing (see Documentation Rules).
- `Dockerfile`, `docker-compose.yml`, `.github/workflows/` — image build + CI/release.
- `dist/`, `apps/web/dist-web/` — generated build output; never edited by hand or committed.

## Documentation Rules

These rules apply to every documentation change in active SelfHelp2 repositories. Copy this section unchanged across repository `AGENTS.md` files so agents get the same documentation contract without following a central link.

- Organize documentation by audience and purpose, not by implementation history: `docs/developer/` for technical architecture/workflow docs, `docs/user/` for non-technical feature/admin/operator guides, `docs/reference/` for exact contracts/tables/schemas/API details, `docs/cookbook/` for task recipes, `docs/operations/` for install/deploy/publish/runbooks, and `docs/archive/` for historical notes.
- Every docs root should have `docs/README.md` as the navigation entrypoint. Tiny repos may keep documentation in the root `README.md` until they need more than one doc. Preserve canonical exceptions such as backend `docs/plugins/` when moving files would break important links; add indexes/status notes first, migrate only after references are updated.
- New or substantially rewritten docs must begin with this metadata block: `Audience`, `Status`, `Applies to`, `Last verified`, `Source of truth`.
- Documentation filenames should use lowercase kebab-case, one `#` title, ASCII punctuation, no emoji headings, repo-relative links, concrete dates instead of "latest/current" when time-sensitive, and no local absolute paths.
- Write developer docs for engineers/technical operators with architecture, contracts, commands, and tradeoffs. Write user docs for non-technical users/operators as task-based steps with expected results and minimal implementation jargon.
- Update documentation in the same change when behavior changes affect user-visible behavior, API contracts, schemas/types, permissions/auth, database/migrations, config/env vars, build/deploy/publish flow, plugin capabilities, or testing commands.
- Do not expose secrets, tokens, private keys, database URLs, Mercure/JWT secrets, or real credentials in docs, examples, logs, or screenshots. Use redacted examples and documented env var names only.
- When docs conflict with runtime behavior, treat runtime behavior as source of truth, flag the stale doc, and update or archive it instead of copying the conflict.

### Manager documentation layout

- `docs/architecture.md` and `docs/developer-guide.md` are the developer entrypoints; `docs/operator/*.md` are task-based operator runbooks; `docs/release-publishing.md` covers cutting + publishing a manager release.
- The root `README.md` is the short overview (what it is, install, CLI + web UI at a glance) and links into `docs/`.
- `CHANGELOG.md` is Keep-a-Changelog style and is updated in the same change as any user-visible CLI/web/behavior change.

## Architecture Rules

- Keep the **instance-scoped** architecture: each instance is fully isolated (own Compose project, network, volumes, secrets, manifest, lock). Shared resources are limited to the single Traefik proxy and the install root layout.
- Keep controllers/commands thin. Domain behavior lives in `packages/*`; `apps/cli` and `apps/web` are adapters that parse input, call package functions, and format output.
- The **server is authoritative** for wizard state and validation (`apps/web/src/wizard.ts`). The web UI mirrors server state; it must not re-implement step order or validation rules client-side.
- Reuse existing packages before adding new ones. Do not create a parallel implementation of registry verification, the Docker guard, instance IO, or auth.
- File writes that matter (manifest, lock, inventory) must be **atomic** (temp file + rename) and must not corrupt existing instance data on failure.
- Inspect related packages, schemas, the wizard/actions, the CLI commands, and existing tests before changing behavior.

## Web UI Rules

- The web UI is **one design system: Mantine**. Build screens from Mantine components + Tailwind utility classes. Do **not** introduce a second, hand-rolled CSS design system.
- Custom CSS is a **last resort**. Prefer Mantine props/components and Tailwind utilities. The only standing global stylesheet is the small Tailwind + Mantine layer entry (`apps/web/src/ui/styles/theme.css`); do not grow it back into a bespoke component library.
- The `apps/web/src/ui/components/*` modules are thin, app-specific compositions **on top of Mantine** (so feature code has a stable, typed surface). They must delegate rendering/styling to Mantine — never hand-rolled markup with custom class names.
- Use `@tanstack/react-query` for BFF/API reads/mutations where it improves structure. The multi-step bootstrap wizard stays a server-driven state machine (`useBootstrap`) — do not force it into query/mutation primitives if that adds complexity.
- Keep it a **local SPA + BFF**. Do not migrate to Next.js. Do not expose the manager publicly by default.
- Never trust a browser-provided `instanceId` / instance scope. The BFF derives instance scope server-side; the UI may *display* scope but must not be the authority.
- The UI must never display secrets (generated passwords, keys, tokens). Run `redactSecrets` on any free-text detail that could carry one, and keep the "password retrieved from the server, shown once" model.
- Preserve existing functionality across changes: mode detection, login, the install wizard, the operations console, health/status views, and operation execution.

## Coding Style

- 2-space indentation, semicolons, single quotes (match existing `apps/`/`packages/` files).
- `strict` TypeScript with `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noImplicitOverride`. No `any` escape hatches; type the boundary.
- Prefer pure, deterministic functions in `packages/*`. Inject side-effecting boundaries (`fetch`, `exec`, clock, fs) so they are testable without real Docker/registry/network.
- Use `I…`/`T…` names where neighbouring code does; keep wire/field names aligned with `@shm/schemas` and the registry/manifest schemas.
- Add the SPDX header to every new source file in the existing format.
- Keep patches small and focused; do not modernize or refactor unrelated areas opportunistically.

## Linting & Quality Gate (mandatory)

Linting and the project quality gate are **mandatory whenever code changes**. ESLint is configured strict and production-ready (flat config in `eslint.config.mjs`). The type-checked TypeScript surface (`**/*.{ts,tsx,mts}`) extends typescript-eslint's flagship **`strictTypeChecked` + `stylisticTypeChecked`** presets via `projectService`, so the full real type-safety rule set (`no-unsafe-*`, `no-base-to-string`, `restrict-*`, `no-floating-promises`/`no-misused-promises`, `use-unknown-in-catch-callback-variable`, …) is enforced rather than a hand-picked subset.

- After changing any TypeScript/JavaScript/React code, you MUST run `npm run lint`. If it fails, fix the issues before finishing — do not hand back red lint. CI runs lint as a **blocking, zero-warning** gate (`npm run lint -- --max-warnings=0`); the config sets every enforced rule to `error`, so a clean local `npm run lint` matches CI. Generated output (`dist/**`, `dist-web/**`, `coverage/**`, `*.d.ts`) is ignored by the flat config so the run is deterministic.
- `npm run lint:fix` may be used for the auto-fixable subset, but review every auto-fix: it must be behavior-preserving (e.g. `no-unnecessary-type-assertion` can disagree with `tsc` — verify with `npm run typecheck`).
- For larger or cross-cutting changes, run the full gate `npm run check` (typecheck + lint + test + validate:schemas + headers:check).
- For changes affecting build output, CLI behavior, Docker/update/registry logic, schemas, or the web app, also run the relevant command: `npm run build`, `npm run validate:schemas`, and/or the targeted tests for the touched area.
- Lint fixes MUST be behavior-preserving. Never change functionality, control flow, return values, public exports, or async behavior just to satisfy lint. If preserving behavior conflicts with a lint rule, preserving behavior wins.
- Hard rules enforced by ESLint (do not regress them):
  - No unused imports.
  - No unused variables/parameters unless intentionally prefixed with `_`.
  - No explicit `any` in production code (allowed only via a narrow, documented inline exception).
  - No floating/unhandled promises (`no-floating-promises`) and no misused promises (`no-misused-promises`) — mark intentional fire-and-forget with `void`.
  - No `any` propagation through the type system (`no-unsafe-*`), relaxed only at the documented Commander CLI / test boundaries in `eslint.config.mjs`.
  - No unchecked stringification (`restrict-template-expressions`, `no-base-to-string`): numbers/booleans are allowed in templates, but objects/`any`/nullish must be stringified deliberately.
  - Consistent, side-effect-free type imports (`consistent-type-imports`) and no duplicate imports.
  - `react-hooks/rules-of-hooks` for the React web UI (`apps/web/**`) — never call hooks conditionally or in loops. `exhaustive-deps` is intentionally off (changing dependency arrays alters effect timing) and `eslint-plugin-react-hooks` is scoped to `apps/web` only, never the Node/CLI packages.
  - SPDX headers must be preserved on every source file.
- A small set of preset rules are **intentionally turned off** in `eslint.config.mjs` because they are not type-safety rules and enforcing them would force behavior changes or pure churn — each carries an inline reason. Do not re-enable them without revisiting that reasoning: `require-await` (dropping `async` changes throw→reject semantics + breaks the uniform async-dep shape), `no-empty-function` (intentional no-ops/EPIPE swallow/stubs), `no-confusing-void-expression` (React `() => handler()` shorthand), `no-unnecessary-condition` (would delete deliberate runtime/SECURITY guards at untyped registry/Docker/JSON boundaries, e.g. `verifyReleaseSignature`), `no-non-null-assertion` (reviewed invariants; the escape hatch we actually ban is `any`), and `prefer-nullish-coalescing` (the code uses `||`/`a ? a : b` for *falsy* fallbacks where `??` would change behavior). Non-shipped code (tests/e2e/scripts) additionally relaxes a few pedantic type-style rules.
- Do **not** disable ESLint rules globally or file-wide to hide problems. A narrow, single-line `eslint-disable-next-line <rule>` with a comment explaining why is acceptable only when the rule is a verified false positive or the only behavior-preserving option; keep such exceptions minimal.
- CI enforces the gate as **blocking** on every PR/push to `main` (`ci.yml`: typecheck → lint `--max-warnings=0` → test → coverage gate → schema/signature validation → headers → build) and again before any tagged image/release (`release.yml` runs `npm run check`, which includes lint `--max-warnings=0`, plus the release smoke). Never merge or release on a red gate, and do not weaken these workflows to go green.
- The final response for any code change MUST state which commands were run (`lint`/`typecheck`/`test`/`build`/`check` as applicable) and their result.

## Testing Rules

- **Run only the tests related to your change.** Scope every run to the touched code (`npx vitest run <path>`, a `-t` filter, or the single new test file). Run the whole suite only before a release/tag.
- **Every change ships with its own focused test(s)**, committed alongside it. Never rely on the existing suite alone to cover new behavior.
- Main commands: `npm test` (Vitest, run mode), `npm run test:watch`, `npm run test:coverage`.
- Web UI tests render through a Mantine-aware wrapper (`apps/web/src/ui/test/render.tsx`) so components have `MantineProvider` + `QueryClientProvider`; `.tsx` tests use the `jsdom` environment (matched in `vitest.config.ts`).
- Do **not** require a real Docker daemon, real registry, or any external service for normal unit tests. Mock those boundaries (injected `fetch`/`exec`/fs, fixtures, the in-memory wizard fake client).
- Static analysis: `npm run typecheck` (root + `@shm/web`) and `npm run lint` MUST pass before finishing.
- Schema/signature fixtures: `npm run validate:schemas`; regenerate signed fixtures only via `npm run fixtures:sign`.

### Canonical Testing Rules (all SelfHelp repos)

These are the canonical SelfHelp testing policy, shared verbatim across the backend, frontend, shared package, mobile app, and every plugin repo. They describe the target conventions; tooling is introduced progressively. A rule applies as soon as the tooling it references exists in this repo.

1. Every new feature ships with at least one automated test at the appropriate layer (unit / integration / contract / E2E).
2. Every bug fix ships with a regression test that fails before the fix and passes after.
3. Every new API endpoint ships with a JSON-schema contract test **and** a permission-matrix test (admin/editor/user/guest + at least one negative cross-scope case).
4. Every new CMS style, action type, scheduled-job type, plugin event subscriber, or plugin realtime topic ships with an integration test for registration → use → cleanup.
5. Every new business workflow extends a golden-workflow test in `tests/Golden/` (backend) and, where a UI is involved, `e2e/golden/` (frontend / mobile).
6. Before writing or changing a test, perform a short **test impact analysis**: which workflow can break, which services/controllers/screens/plugin contracts are touched, which existing tests should fail, which new regression test is needed. Tests existing only to inflate coverage are rejected.
7. Tests do not depend on developer credentials. Use the seeded `qa.admin/editor/user/guest@selfhelp.test` personas.
8. QA fixtures use the production permission model. Seed test users through the same `Lookup userStatus/userTypes`, `Group`, `Role`, and `rel_groups_users` entities that production `src/Command/CreateAdminUserCommand.php` uses. Special permissions go through normal admin/domain services, never raw SQL.
9. All test data writes use the `qa.` / `qa-` / `qa_` prefix. Tests never create/update/delete non-QA business records. Read-only access to system baselines (languages, permissions, styles, lookups, plugin metadata, role/group/page-type) is allowed.
10. Tests self-clean (DAMA transaction rollback or an explicit `afterEach`). Integration/golden tests pass the `QaCleanupVerifier` (or the per-repo equivalent).
11. Do not mock domain behaviour in integration/golden tests. Unit tests may use deterministic test doubles but must not hide real business logic. Mock external dependencies (network, time, filesystem) at the boundary only.
12. Date/time tests use `Symfony\Bridge\PhpUnit\ClockMock` (PHP), `vi.useFakeTimers()` (Vitest), or `page.clock.install()` (Playwright).
13. Mercure events are verified via `MercureTestRecorder` (backend) or `mockMercureHub` (shared); never by polling.
14. Anti-flakiness: no `sleep()`, no external internet, no random IDs in fixtures or assertions, no order-dependent tests, no developer-machine absolute paths.
15. The full suite passes in random order. `composer test:random` (or the per-repo equivalent) runs nightly.
16. Test names describe business behaviour, not the method under test (e.g. `testFinishedFormSubmissionSchedulesAndExecutesActionEmailJob`, not `testSubmit`).
17. Prefer asserting public/domain-visible effects (API response, admin API view of scheduled jobs, Mercure event, rendered page) before internal implementation details. DB/queue assertions are secondary or a fallback.
18. Snapshot updates (Vitest, Playwright screenshots, response fixtures) must be intentional: the change is expected, the PR explains why, and a reviewer can compare before/after. Never run `--update-snapshots` just to make CI green.
19. Performance: any test slower than 10s is `@group golden` under `tests/Golden/` (or the per-repo golden area). PR-tier suites complete in under 10 minutes per repo.
20. Coverage gates: ≥ 70% line on `src/Service/**` + `src/Controller/**` (backend); ≥ 60% on new files (other repos). PRs dropping coverage by > 1% on changed files are blocked.
21. Use the standard test commands defined in this repo's Build / Dev Commands section. Never invent new test command names.
22. Tests assert **meaningful behaviour**, not just status codes. At minimum: status + envelope shape + key returned fields + one public side effect.
23. **Do not change production logic to make tests pass.** If a test reveals a production issue, fix the production code and explain in the PR. If the test expectation is wrong, fix the test.
24. **Smallest runnable proof**: after every 1–3 file changes, run `test:changed` (or the single new test file). Do not extend a slice while its current state is red for an unknown reason.
25. **Contract tests for FE/mobile/plugin-consumed responses**: every API response field consumed by frontend, mobile, or plugin code must exist in a JSON Schema under `config/schemas/api/v1/` plus a TypeScript type in `@selfhelp/shared`. Schema drift fails CI. Consumers must not depend on undocumented response fields.
26. **Negative-permission tests are mandatory** for every permission-sensitive endpoint: allowed user → success; lower-privileged user → 403; unauthenticated user → 401; cross-scope/group user → 403 or 404 per the established access rule.
27. **Security regression tests** are required for any change to authentication, authorization, CSRF, JWT issuance/refresh/revocation, logout/session invalidation, plugin trust level or capabilities, or ACL cache invalidation. Security tests assert failure behaviour, not only success.
28. **API backward compatibility**: do not remove or rename a response field without (a) a schema version bump, (b) a shared TS type update, (c) frontend/mobile/plugin adaptation in the same PR, and (d) a changelog entry.
29. **Performance budgets** for critical APIs are asserted in smoke/golden tests: login < 500 ms, admin pages list < 1000 ms, form submit < 1000 ms in the test env. Regressions above 2× the budget block PRs; 1.5×–2× warns.
30. **No real outbound** in tests: tests never send real email/SMS/push/webhooks/external HTTP. Use `RecordingNotifier`, MSW, or a mocked HTTP client, and assert the content of the captured message.
31. **Environment isolation**: test reset commands refuse to run unless `APP_ENV=test`, the database name contains `_test`, the host is in the allow-list, and `--force` is provided. Reset prints the target database name before destroying it.
32. **Fixture version**: `QaBaselineFixture` exposes `QA_FIXTURE_VERSION`; smoke tests print and assert it. Stale fixtures fail fast with a clear message.
33. **CI failure artifacts**: CI uploads PHPUnit logs, coverage report, Playwright traces/videos/screenshots, docker container logs, and a sanitized test DB dump for failed golden tests.
34. **Accessibility checks** for Playwright golden specs use axe-core on the login page, admin page editor, public form page, and plugin admin page.

### Manager-specific testing additions

- The manager has no Symfony/DB/Mercure layer, so rules that name backend fixtures/personas, JWT, ACL, Mercure, or QA database seeding apply only to the SelfHelp repos those tools live in. The manager honors the **spirit**: deterministic, isolated, no real outbound, behaviour-named tests, regression test per bug, focused test per feature.
- Critical packages must have unit tests for their security-relevant logic: registry signature/checksum/canonical-payload validation, resolver compatibility/advisory/`requiresManager` behaviour, the Docker guard (forbidden flags), instance manifest/lock atomic writes, update dry-run/preflight/execute paths, backup/support redaction + integrity, and auth session/password/local-operator logic.
- Web UI tests cover at least: the login flow, install-wizard rendering + validation gating, console/status rendering, and API error handling — all against the in-memory fake client or injected `fetch`, never a real BFF.
- "No real outbound / no external services" (rules 14, 30) is enforced for the manager by always injecting `fetch`/`exec`/fs and using fixtures; a test that would shell out to Docker or hit the network is a violation.

## Release Rules

- The manager tool uses its own semver tracked in `CHANGELOG.md` (currently `0.x`, e.g. `0.1.0`); tags are `v*` and drive `manager-release`. It is independent of the SelfHelp platform version it installs (also `0.x` pre-release).
- A release MUST pass the quality gate (`npm run check`: typecheck + lint + test + schema/signature validation) and the license report.
- Released images are built + pushed to GHCR with an SPDX **SBOM**, a Trivy scan (advisory), and **cosign** signing when a signing key is configured. Do not remove the SBOM/scan/signing steps.
- Keep the **signed release / trusted registry** model intact: never weaken or bypass registry signature/checksum verification, and never add an untrusted key to the trusted-keys set without an explicit governance reason.

## Security Rules

- **Docker socket access belongs to the manager process only.** Never mount the Docker socket into a *runtime* SelfHelp container, and never generate Compose that does so.
- **Never** emit or run `docker compose down -v` or any command that can delete instance volumes/data. The Docker guard exists to block dangerous flags — extend it, do not route around it.
- Secrets (DB passwords, app keys, admin password, JWT/Mercure secrets, signing keys) are generated and written to **restricted files** on the server and shown once by the install process. They are never printed to logs, the web UI, support bundles, or docs. Redact defensively.
- The web BFF binds to localhost / private access by default. Remote use is via SSH tunnel. Do not add a default public bind.
- Operator auth (`@shm/auth`): keep password hashing, session handling, CSRF tokens for state-changing requests, and the first-run bootstrap-token flow intact. Auth is local-only (no campus/OIDC/SSO); remote access is via SSH tunnel. Security-sensitive changes need a regression test that asserts the failure path.
- Verify before you trust: every release/manifest is checked for checksum + Ed25519 signature against trusted keys before install. Honor advisories and `requiresManager` gating from the resolver.
- Never trust browser-provided instance scope; derive it server-side.

## AGENTS.local.md

- `AGENTS.local.md` is **local-only** (git-ignored) and exists for per-developer machine paths (sibling repo locations, etc.). It is **not** a substitute for this file.
- This committed `AGENTS.md` is the authoritative, shared contract for the repo. Do not move rules from here into `AGENTS.local.md`, and do not assume a reader has any `AGENTS.local.md`.

## Build / Dev Commands

- `npm install` — install workspace dependencies.
- `npm run typecheck` — strict TS for root packages/CLI scripts **and** `@shm/web`.
- `npm run lint` — ESLint (flat config) across the repo.
- `npm test` / `npm run test:watch` / `npm run test:coverage` — Vitest.
- `npm run validate:schemas` — JSON Schema + signed-fixture validation.
- `npm run fixtures:sign` — regenerate signed test fixtures (only when intended).
- `npm run license:report` — dependency license policy report.
- `npm run build` — build packages/CLI (`tsc` + `tsc-alias`) and the web SPA (`vite build` → `apps/web/dist-web/`).
- `npm run check` — the CI gate: typecheck + lint + test + validate:schemas.
- `npm run cli -- <args>` — run the CLI from source (e.g. `npm run cli -- doctor`).
- `npm -w @shm/web run dev` — run the web UI (Vite dev server + BFF proxy).
- `docker compose up -d` — run the manager image locally (never use `-v` on down).

## Common Tasks

- **Add a CLI command**: add the command under `apps/cli` wiring to a `packages/*` function, keep the command thin, add a unit test for the package logic, and document it in `docs/` + `README.md`.
- **Add/extend a registry or manifest field**: update `@shm/schemas` (schema + TS type) first, then the consumers (`registry`/`resolver`/`instances`), add fixtures + tests, and update `docs/release-publishing.md`.
- **Add a web UI screen/step**: build it from Mantine components, drive it from server state (extend `wizard.ts`/`actions.ts` if needed), wire data via react-query, render through the Mantine test wrapper, and add a web UI test.
- **Touch verification/guard/auth**: add a security regression test asserting the failure path, and update the relevant `docs/operator/*` runbook.

## Do Not Do

- Do not mount the Docker socket into runtime containers or generate Compose that does.
- Do not run or generate `docker compose down -v` (or any data-deleting command) anywhere.
- Do not weaken registry signature/checksum/trusted-key verification or the resolver's advisory/`requiresManager` gating.
- Do not trust a browser-provided `instanceId`/scope.
- Do not display, log, or document secrets; do not commit `dist/`, `apps/web/dist-web/`, or `AGENTS.local.md`.
- Do not migrate the web UI to Next.js or add a second (hand-rolled) design system; prefer Mantine + Tailwind, custom CSS last.
- Do not require a real Docker daemon, registry, or network in unit tests.
- Do not change the manager's semver scheme or bypass the release quality gate, SBOM, scan, or signing.
- Do not introduce dependencies without a clear need and a lockfile update.
