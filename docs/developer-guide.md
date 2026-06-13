# Developer guide

Audience: Developers
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`)
Last verified: 2026-06-08
Source of truth: `package.json`, `apps/`, `packages/`, `AGENTS.md`

Read [`AGENTS.md`](../AGENTS.md) first — it is the binding contract for this
repository. This guide is the practical companion.

## Prerequisites

- **Node.js >= 22** (manager tooling).
- **Docker Engine + Docker Compose v2** — only needed to actually install/run
  instances. The test suite does **not** need Docker.

## Setup

```bash
npm install
npm run check   # typecheck + lint + test + validate:schemas
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` for the monorepo **and** the web app. |
| `npm run lint` | ESLint over the whole repo. |
| `npm run test` | Vitest run (packages + CLI + web BFF + web UI). |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:coverage` | Vitest with V8 coverage. |
| `npm run coverage:gate` | CI coverage gate: the backup engine (`packages/backup`) + the web backup-scheduler loop must stay >= 70% covered (scoped — legacy files cannot trip it). |
| `npm run validate:schemas` | Validate the JSON Schemas + examples. |
| `npm run build` | Build packages (tsc + tsc-alias) and the web SPA (Vite). |
| `npm run cli -- <args>` | Run the CLI from source (`tsx`), e.g. `npm run cli -- --help`. |
| `npm run fixtures:sign` | Re-sign the registry test fixtures. |
| `npm run license:report` | License report for dependencies. |
| `npm run check` | The full local gate (typecheck + lint + test + schemas). |

`npm run check` is the gate; it must be green before a change is considered done.

## Running the web UI in development

The SPA and the BFF run as two processes (the BFF owns `/api`, Vite serves the
SPA and proxies `/api` to it):

```bash
# Terminal 1 — the BFF (localhost only, port 8765)
npm -w @shm/web exec sh-manager-web -- --root ./.dev-root
# or: npx tsx apps/web/src/bin.ts --root ./.dev-root

# Terminal 2 — the SPA dev server (http://localhost:5173, proxies /api -> 8765)
npm -w @shm/web run dev
```

Override the proxy target with `SHM_WEB_API`. The console is authenticated:
on a fresh `--root` the UI offers the one-time first-operator setup screen;
afterwards sign in with that account (see
[security hardening](operator/security-hardening.md)).

## Testing strategy

The suite follows the canonical SelfHelp testing rules (see `AGENTS.md`):

- **Pure logic** in `packages/*` is unit-tested directly with in-memory fakes
  for the injected boundaries — no Docker, no network, no real registry.
- **CLI actions** are tested offline against signed **fixture** registries
  (`apps/cli/src/cli.test.ts`, `admin.test.ts`, `operations-client.test.ts`).
- **BFF** behaviour is tested via its request handler (`apps/web/src/server.test.ts`).
- **Web UI** tests (`apps/web/src/ui/**/*.test.tsx`) run under jsdom. They render
  components through the shared wrapper in `apps/web/src/ui/test/render.tsx`
  (which provides `MantineProvider`, `QueryClientProvider`, and `Notifications`)
  against the in-memory `ApiClient` fake in `apps/web/src/ui/test/fake-client.ts`
  — which reuses the **real** request validation (`instance-validation.ts`), so
  flow tests exercise the same gating and validation production uses.

Run everything with `npm test`; scope while iterating with
`npx vitest run <path>` or `npx vitest run apps/web/src/ui`.

### What every change must ship

- A new feature: at least one test at the right layer.
- A bug fix: a regression test that fails before and passes after.
- A new web UI view/flow: a Testing-Library test (render + key interaction +
  error path).

## Web UI conventions

- Compose UIs from **Mantine** components and **Tailwind** utilities. Custom CSS
  is a last resort; there is no second design system.
- `apps/web/src/ui/styles/theme.css` is intentionally tiny: it only declares the
  CSS layer order and imports the Mantine + Tailwind layers. Do not grow it back
  into a hand-rolled stylesheet.
- The shared component library is in `apps/web/src/ui/components/`. These wrap
  Mantine while keeping small, stable prop APIs so feature code stays terse.
- All BFF access goes through the typed `ApiClient`; surface failures as
  `ApiError` and render them (never swallow). Use React Query (`useQuery` /
  `useMutation`) rather than ad-hoc `useEffect` fetching.
- React 19 dropped the global `JSX` namespace; `apps/web/src/react-jsx.d.ts`
  restores the `JSX.Element` alias so existing return-type annotations keep
  working.

## Adding things

### A new CLI command

1. Add the pure orchestration to `apps/cli/src/actions.ts` (boundary effects via
   the injected `ActionDeps`).
2. Wire the Commander subcommand in `apps/cli/src/bin.ts`.
3. Add an offline test in `apps/cli/src/cli.test.ts` against the signed fixtures.

### A new package

1. `packages/<name>/` with its own `package.json` (`@shm/<name>`), `tsconfig`,
   and `src/`.
2. Add the source alias to `vitest.config.ts` and `apps/web/vite.config.ts`.
3. Keep the logic pure; expose any side effect as an injected interface.

### A new create-wizard step or field (web UI)

1. Server first: extend the request validation in
   `apps/web/src/instance-validation.ts` (shared by the BFF and the UI) and,
   if the BFF action surface changes, `apps/web/src/instances.ts` +
   `apps/web/src/server.ts`.
2. Add the step/field to
   `apps/web/src/ui/features/manager/CreateInstanceWizard.tsx`.
3. Add a flow test to
   `apps/web/src/ui/features/manager/InstanceManagement.test.tsx` (and a BFF
   test in `apps/web/src/server.test.ts` for new endpoints).

## Boundaries you must not cross

See `AGENTS.md` for the full list. The load-bearing ones:

- No Docker socket in any runtime container (only the shared proxy, read-only).
- Never `docker compose down -v` or delete MySQL volumes outside an explicit,
  confirmed full delete.
- Never trust a browser-provided `instanceId`.
- Keep the signed-release / trusted-registry model intact; never accept
  unsigned/`dev`-keyed releases in production.
