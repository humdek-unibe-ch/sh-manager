# Rehearse the publish, install, and update pipeline (staging)

Audience: Server operators and release engineers
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`, installs SelfHelp 8.x)
Last verified: 2026-06-09
Source of truth: `e2e/build-images.mjs`, `e2e/build-test-registry.mjs`, `e2e/serve-registry.mjs`, `e2e/docker-e2e.test.ts`, `apps/cli/src/bin.ts`

This is a **safe, repeatable rehearsal** of the whole distribution pipeline —
publish a release, install an instance, update it (two ways), then exercise
backup, restore, clone, and rollback — using:

- the **`test`** release channel (additive; never `stable`),
- **dev-signed** release metadata (the deterministic dev key, not the production
  key),
- locally-built **`:e2e`** Docker images (never pulled from a public registry),
- a **disposable** server root.

It **never** touches the public registry, GitHub Pages, or any production key, so
you can run it as often as you like. For the real public release, see
[release-publishing.md](../release-publishing.md) and the registry's
`docs/operations/publishing.md` ("Real public release: end-to-end runbook").

## What you need

- Docker Engine + Docker Compose v2 (`docker compose version`).
- This `sh-manager` checkout with the two source repos checked out **next to it**
  as siblings, so the images can build:

  ```text
  <parent>/sh-manager
  <parent>/sh-selfhelp_backend
  <parent>/sh-selfhelp_frontend
  ```

- Dependencies installed once: `cd sh-manager && npm ci`.

## The fast path: one command

The entire rehearsal is automated as the manager's Docker e2e. From the
`sh-manager` checkout:

```bash
SHM_E2E=1 npm run e2e
```

This builds the four `:e2e` images, assembles a dev-signed `test`-channel
registry (versions `0.1.0` + `0.1.1`), serves it on localhost, then drives the
full journey against disposable instances:

- fresh install + provision, HTTP `/cms-api/v1/health`, and admin login;
- manager-driven update `0.1.0 → 0.1.1` (backup taken, MySQL volume preserved);
- CMS-driven update (request → `process-operations` → status `succeeded`);
- backup → same-instance restore (secrets preserved);
- clone (fresh secrets, source untouched);
- a forced pre-migration failure that **rolls back** cleanly;
- two-instance isolation and the three remove modes.

Expected tail:

```text
 ✓ e2e/docker-e2e.test.ts (… tests) …
 Test Files  1 passed (1)
```

It self-cleans (removes its disposable instances and temp registry). Without
`SHM_E2E=1` (or without Docker) the suite is **skipped**, so it never runs on the
fast PR gate — it runs here and in the nightly `e2e-docker.yml` workflow.

The rest of this page is the **same journey done by hand**, so you can watch each
step and poke at the instance in between.

## The manual rehearsal (copy-paste)

> These steps use the `sh-manager` CLI exactly as the other operator guides do
> (see [install.md](install.md)). From a source checkout, build the CLI first
> (`npm run build`) and put it on your `PATH`, or simply use the automated
> `npm run e2e` above. Run every command from the `sh-manager` directory.

### 1. Build the four test images

```bash
node e2e/build-images.mjs
```

Builds `backend`, `worker`, `scheduler` (from `sh-selfhelp_backend/docker/Dockerfile`)
and `frontend` (from `sh-selfhelp_frontend/Dockerfile`), each tagged `:e2e`. First
run takes a few minutes; later runs are mostly cache hits. Expected output:

```json
{
  "backend": "ghcr.io/humdek-unibe-ch/selfhelp-backend:e2e",
  "worker": "ghcr.io/humdek-unibe-ch/selfhelp-worker:e2e",
  "scheduler": "ghcr.io/humdek-unibe-ch/selfhelp-scheduler:e2e",
  "frontend": "ghcr.io/humdek-unibe-ch/selfhelp-frontend:e2e"
}
```

### 2. Assemble a dev-signed test registry

```bash
node e2e/build-test-registry.mjs --out /tmp/sh-test-registry
```

Reads the real local image digests (`docker image inspect`) and writes
`test`-channel, **dev-signed** core/frontend/scheduler/worker releases for two
versions (`0.1.0` and `0.1.1`), plus `registry.json` and a `keys/trusted-keys.json`
holding only the dev **public** key. Expected output:

```json
{
  "dir": "/tmp/sh-test-registry",
  "trustedKeysPath": "/tmp/sh-test-registry/keys/trusted-keys.json",
  "base": "0.1.0",
  "next": "0.1.1"
}
```

The `0.1.1` release is your "published update". To rehearse a real code change,
edit the source and re-run steps 1–2: the new image digests flow into `0.1.1`.

### 3. Serve the registry on localhost

In its own terminal (leave it running):

```bash
node e2e/serve-registry.mjs /tmp/sh-test-registry 8787
# serving /tmp/sh-test-registry at http://127.0.0.1:8787/
# press Ctrl+C to stop
```

### 4. Point the manager at the dev trust root + a disposable root

```bash
export SELFHELP_TRUSTED_KEYS=/tmp/sh-test-registry/keys/trusted-keys.json
export SELFHELP_ROOT=/tmp/sh-rehearsal
```

`SELFHELP_TRUSTED_KEYS` makes signature verification run **for real** against the
dev key; `SELFHELP_ROOT` keeps every file under a throwaway directory.

### 5. Bootstrap a local server and install the base version

```bash
sh-manager server init --server-id rehearsal --mode local

sh-manager instance install --id rehearsal1 --mode local --port 8080 \
  --registry http://127.0.0.1:8787/ --channel test --version 0.1.0 \
  --provision --admin-email admin@example.test
```

The install pulls the dev-signed `0.1.0` release, verifies its signature against
the dev trusted-keys file, brings the stack up, provisions (DB → migrate → admin
→ plugins → caches → health-check), and prints a generated admin password
**once**. Save it.

### 6. Verify health and admin login

```bash
curl -fsS http://127.0.0.1:8080/cms-api/v1/health
# {"status":200,...,"data":{"overall":"healthy",...}}

sh-manager instance health rehearsal1
```

(The automated e2e additionally logs in as the admin over HTTP; for the manual
run the readiness probe above is enough.)

### 7. Update via the manager (path A)

Always dry-run first:

```bash
sh-manager instance update rehearsal1 --channel test --version 0.1.1 --dry-run
sh-manager instance update rehearsal1 --channel test --version 0.1.1
sh-manager instance health rehearsal1
```

The manager takes a **backup first**, re-pins the `0.1.1` digests in `lock.json`,
runs migrations, and health-checks; on any failure it **rolls back**. The MySQL
data volume is never torn down. Confirm the reported version moved to `0.1.1`.
Full flag reference: [update.md](update.md).

### 8. Update via the CMS (path B)

The CMS never controls Docker; it records an **instance-scoped** request that the
manager claims and executes. From the instance's admin UI, open **System →
Maintenance & updates**, request an update to `0.1.1`, then let the manager
process it:

```bash
sh-manager instance process-operations rehearsal1 \
  --backend-url http://127.0.0.1:8080 --token "$SELFHELP_MANAGER_TOKEN"
```

Poll **System → Maintenance & updates** (or `GET /cms-api/v1/admin/system/update/status`)
until it reads `succeeded`. The per-instance `SELFHELP_MANAGER_TOKEN` authenticates
the manager to that one backend; the backend derives the instance id server-side
and rejects any browser-supplied id. See the frontend
`docs/developer/system-maintenance-admin.md` for the admin-UI side.

### 9. Backup, then restore the same instance

```bash
sh-manager instance backup rehearsal1
# Backup <id> -> /tmp/sh-rehearsal/instances/rehearsal1/backups/<id>

sh-manager instance restore rehearsal1 <id>            # validate + plan only
sh-manager instance restore rehearsal1 <id> --apply    # same-instance: secrets preserved
```

A same-instance restore **preserves** the existing secrets and identity. Full
flow + clone-style restores: [backup-restore.md](backup-restore.md).

### 10. Clone (source stays untouched)

```bash
sh-manager instance clone rehearsal1 rehearsal2 --domain rehearsal2.localhost
sh-manager instance clone rehearsal1 rehearsal2 --domain rehearsal2.localhost --apply

sh-manager instance health rehearsal1   # source still healthy
sh-manager instance health rehearsal2   # clone healthy, fresh secrets
```

The clone gets **fresh secrets** and isolated Docker state; the source shares
nothing with it. Flags (uploads/plugins/version pinning): [clone-remove.md](clone-remove.md).

### 11. Rollback (forced-failure rehearsal)

Rollback is exercised automatically by the e2e (it injects a failing health check
and asserts the manager restores `compose`/`manifest`/`lock` and clears
maintenance). To see it by hand, trigger an update that cannot pass health and
watch the manager report `ROLLED BACK`; recovery details are in
[safe-mode-and-recovery.md](safe-mode-and-recovery.md).

### 12. Clean up

```bash
sh-manager instance remove rehearsal2 --mode full_delete --delete-volumes --confirm "delete rehearsal2"
sh-manager instance remove rehearsal1 --mode full_delete --delete-volumes --confirm "delete rehearsal1"
# stop the serve-registry terminal (Ctrl+C), then:
rm -rf /tmp/sh-rehearsal /tmp/sh-test-registry
```

## Safety guarantees

- Everything runs on the **`test`** channel, **dev-signed**, against **local
  `:e2e` images** and a **disposable** `SELFHELP_ROOT`.
- It never contacts the public registry, never publishes GitHub Pages, and never
  uses the production signing key.
- The proxy and any other instances are untouched; only the `rehearsal*`
  instances you created are removed in step 12.

## Related

- [Install](install.md) · [Update](update.md) · [Backup & restore](backup-restore.md) · [Clone & remove](clone-remove.md) · [Safe mode & recovery](safe-mode-and-recovery.md)
- [Release & publishing](../release-publishing.md) — the real public release path.
- Registry `docs/operations/publishing.md` / `docs/operations/signing.md` — how a
  release is signed and published to the official catalogue.
