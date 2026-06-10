# Local Windows walkthrough: install, GUI, publish a small update, update

Audience: Server operators and developers new to the SelfHelp Manager
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`, SelfHelp 0.x pre-release line) on Windows 10/11
Last verified: 2026-06-10
Source of truth: `apps/cli/src/bin.ts`, `apps/web/src/bin.ts`, `e2e/build-images.mjs`, `e2e/build-test-registry.mjs`, `e2e/serve-registry.mjs`, [rehearsal-publish-install-update.md](rehearsal-publish-install-update.md)

This is the **beginner-friendly, copy-paste guide** for trying the whole
SelfHelp distribution story on a Windows machine, end to end, without touching
anything public:

1. install the manager from source,
2. install a SelfHelp instance with the **GUI wizard** (and the CLI),
3. "publish" a small update to a **local test registry**,
4. update the instance **via the manager** and **via the CMS admin UI**.

Everything runs against a disposable directory, a localhost-only registry, and
dev-signed `test`-channel releases. Nothing here can reach the public registry
or production keys. It is the Windows-flavoured companion of
[rehearsal-publish-install-update.md](rehearsal-publish-install-update.md);
read that page for the "why" behind each step.

## 0. What you need (once)

| Tool | Why | Check |
|------|-----|-------|
| **Docker Desktop** (WSL2 backend) | All SelfHelp services are containers | `docker compose version` |
| **Node.js 22+** | The manager is a Node/TypeScript monorepo | `node --version` |
| **Git** + **Git Bash** | All commands below are written for Git Bash | `git --version` |

> Use **Git Bash** (ships with Git for Windows) for every command in this
> guide. PowerShell works too, but `export VAR=...` becomes
> `$env:VAR = "..."` and paths differ — Git Bash keeps the commands identical
> to the Linux docs.

Check out the three repos **as siblings** (the image builds expect this):

```text
D:/TPF/SelfHelp/sh-manager
D:/TPF/SelfHelp/sh-selfhelp_backend
D:/TPF/SelfHelp/sh-selfhelp_frontend
```

Then install dependencies once:

```bash
cd /d/TPF/SelfHelp/sh-manager
npm ci
```

## 1. Build the SelfHelp images locally

```bash
node e2e/build-images.mjs
```

This builds the four images (`backend`, `worker`, `scheduler` from
`sh-selfhelp_backend/docker/Dockerfile`; `frontend` from
`sh-selfhelp_frontend/Dockerfile`), each tagged `:e2e`. The first run takes a
few minutes; afterwards it is mostly Docker cache hits. Expected output ends
with the four image names.

> Docker Desktop must be running. If the build fails immediately, open Docker
> Desktop and wait until the whale icon stops animating, then retry.

## 2. "Publish" a release: build and serve a local test registry

```bash
node e2e/build-test-registry.mjs --out "$HOME/sh-test-registry"
```

This reads your local image digests and writes a complete dev-signed registry
with **two versions: `0.1.0` (base) and `0.1.1` (the update you will install
later)** — the same `registry.json` + signed release documents the public
registry serves, but on the `test` channel with the dev key.

Serve it in **its own Git Bash window** and leave it running:

```bash
cd /d/TPF/SelfHelp/sh-manager
node e2e/serve-registry.mjs "$HOME/sh-test-registry" 8787
# serving ... at http://127.0.0.1:8787/  — press Ctrl+C to stop
```

Sanity check: open <http://127.0.0.1:8787/registry.json> in a browser. You
should see `core`, `frontend`, `scheduler`, `worker`, and `plugins` arrays.

## 3. Point the manager at the test registry and a throwaway root

In the Git Bash window you will run manager commands from:

```bash
cd /d/TPF/SelfHelp/sh-manager
export SELFHELP_TRUSTED_KEYS="$HOME/sh-test-registry/keys/trusted-keys.json"
export SELFHELP_ROOT="$HOME/sh-root"
```

- `SELFHELP_TRUSTED_KEYS` — signature verification runs for real, against the
  dev key the test registry was signed with.
- `SELFHELP_ROOT` — every file the manager writes (instances, backups,
  manifests) lands under this throwaway directory. Delete it afterwards and
  your machine is clean.

> These variables only exist in the current Git Bash window. If you open a new
> window, export them again.

## 4. Install an instance — Option A: the GUI wizard

Build the wizard SPA once, then start the localhost-only web UI:

```bash
npm run build
npm -w @shm/web exec sh-manager-web -- --root "$HOME/sh-root"
# SelfHelp Manager bootstrap UI listening on http://127.0.0.1:8765
```

Open <http://127.0.0.1:8765> and walk the wizard:

1. **Environment checks** — Docker, outbound HTTPS, host resources. All should
   be green (the internet check needs any outbound HTTPS, not the registry).
2. **Registry** — enter `http://127.0.0.1:8787/` as the registry URL. The
   wizard fetches the index and verifies the release signature against your
   dev trusted-keys file: expect "Registry reachable and signature verified".
3. **Instance** — choose mode **local**, id `demo1`, port `8080`, channel
   `test`, version `0.1.0`, and an admin email.
4. **Install** — the wizard pulls the images, brings the stack up, provisions
   (DB → migrations → admin user → caches → health), and shows the generated
   admin password **once**. Save it.

The wizard self-locks after a successful bootstrap install — that is by
design (see [post-install-checklist.md](post-install-checklist.md)).

## 4b. Install an instance — Option B: the CLI

The same install from the command line (skip if you used the wizard; or use a
different id/port to have two instances side by side):

```bash
npm run cli -- server init --server-id demo --mode local

npm run cli -- instance install --id demo1 --mode local --port 8080 \
  --registry http://127.0.0.1:8787/ --channel test --version 0.1.0 \
  --provision --admin-email admin@example.test
```

Verify it is alive:

```bash
curl -fsS http://127.0.0.1:8080/cms-api/v1/health
npm run cli -- instance health demo1
```

Log in at <http://127.0.0.1:8080> with the admin email + printed password, and
open **Admin → System** — the page shows SelfHelp `0.1.0`, the deployment kind
**Docker image**, and the frontend version injected by the manager.

## 5. Make a small change and "push" the update

The test registry already contains `0.1.1` built from the same images, so you
can update right away. To rehearse a **real code change**:

1. Edit something visible in `sh-selfhelp_backend` or `sh-selfhelp_frontend`.
2. Rebuild the images and the registry — the new digests flow into `0.1.1`:

   ```bash
   node e2e/build-images.mjs
   node e2e/build-test-registry.mjs --out "$HOME/sh-test-registry"
   ```

   (The registry server picks up the new files automatically; no restart needed.)

This mirrors the real pipeline: tag → CI builds images → digests are written
into a signed core release in the registry. The real flow is documented in the
registry repo's `docs/operations/release-runbook.md`.

## 6. Update the instance — path A: via the manager

Always dry-run first:

```bash
npm run cli -- instance update demo1 --channel test --version 0.1.1 --dry-run
npm run cli -- instance update demo1 --channel test --version 0.1.1
npm run cli -- instance health demo1
```

The manager takes a backup first, re-pins the `0.1.1` digests, runs
migrations, and health-checks; on failure it rolls back automatically. Reload
**Admin → System** in the CMS — the version now reads `0.1.1`.

## 7. Update the instance — path B: requested from the CMS

The CMS never controls Docker. An admin **requests** an update; the manager
claims and executes it:

1. In the instance's admin UI open **Admin → System** (Maintenance & updates).
2. Pick the target version — the dropdown is fed by the registry — and click
   **Check compatibility**, then **Request update** to `0.1.1` (if you are
   already on `0.1.1`, rebuild the registry with a newer version first).
3. Let the manager process the queued request:

   ```bash
   npm run cli -- instance process-operations demo1 \
     --backend-url http://127.0.0.1:8080 --token "$SELFHELP_MANAGER_TOKEN"
   ```

   The per-instance `SELFHELP_MANAGER_TOKEN` is in the instance's `.env` under
   `$SELFHELP_ROOT/instances/demo1/`.
4. Watch the status on the same admin page until it reads **succeeded**.

## 8. Clean up

```bash
npm run cli -- instance remove demo1 --destroy-data --yes
rm -rf "$HOME/sh-root" "$HOME/sh-test-registry"
```

Stop the registry server window with `Ctrl+C`. Docker images tagged `:e2e` can
stay (they are reused on the next rehearsal) or be removed with
`docker image prune`.

## Troubleshooting (Windows specifics)

| Symptom | Cause / fix |
|---------|-------------|
| `docker: command not found` in Git Bash | Docker Desktop not running, or Git Bash opened before Docker was installed — restart the terminal. |
| Image build extremely slow | Ensure the repos live on a local NTFS drive (not a network share) and WSL2 backend is enabled in Docker Desktop settings. |
| Port `8080`/`8787`/`8765` already in use | Pick other ports (`--port`, the serve-registry port argument, `--port` on `sh-manager-web`). |
| `export` not recognised | You are in PowerShell/cmd — use Git Bash, or translate to `$env:NAME = "value"`. |
| Health check fails right after install | First boot can take a minute on Windows filesystems; re-run `npm run cli -- instance health demo1`. |
| Wizard says registry unreachable | The serve-registry window was closed, or you typed `https` instead of `http` for the local URL. |

## Where to go next

- The full pipeline rehearsal (backup, restore, clone, rollback, two-instance
  isolation): [rehearsal-publish-install-update.md](rehearsal-publish-install-update.md)
- Real production install on a server: [install.md](install.md)
- How real releases are published (tags → images → signed registry entries):
  `sh2-plugin-registry` repo, `docs/operations/release-runbook.md`
