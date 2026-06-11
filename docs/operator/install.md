# Install a server and your first instance

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.5`, installs the SelfHelp 0.x pre-release line)
Last verified: 2026-06-11
Source of truth: `apps/cli/src/bin.ts`, `apps/web/src/bin.ts`, `apps/web/src/server.ts`

This installs SelfHelp on a fresh server in two stages: **bootstrap the server**
(one shared reverse proxy + an inventory) and **install an instance** (an
isolated SelfHelp site). You can do both from the **web wizard** or the **CLI**.

> Testing on a Windows machine instead of a server? Use the
> [Windows quickstart](windows-quickstart.md) — same flow in local mode
> (localhost ports, no domains/TLS).

## Before you start

- A Linux server with **Docker Engine + Docker Compose v2**.
- For a production install: a **domain name** whose DNS points at this server,
  and ports **80/443** free.
- The manager runs as the only privileged tool. Do not expose the wizard to the
  internet — it binds to `127.0.0.1`; reach it over an **SSH tunnel** for a
  remote server.

## Get the manager

The recommended way to run the manager is the published Docker image — nothing
to build or install beyond Docker itself:

```bash
docker pull ghcr.io/humdek-unibe-ch/sh-manager:latest

# define once per shell; every command below then reads `shm ...`
alias shm='docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/selfhelp:/opt/selfhelp \
  ghcr.io/humdek-unibe-ch/sh-manager:latest'
shm --version
```

Alternatively, let the image generate a persistent wrapper script into the
state folder (same effect as the alias, plus it handles the GUI port for
`shm web` and survives new shells):

```bash
mkdir -p /opt/selfhelp && cd /opt/selfhelp
docker run --rm ghcr.io/humdek-unibe-ch/sh-manager:latest wrapper --shell bash > shm.sh && chmod +x shm.sh
./shm.sh --version
```

The state mount must be present on **every** invocation — without it commands
fail with `ENOENT ... selfhelp.server.json` ("not initialized"). Mounting it
at `/opt/selfhelp` on both sides is the documented default; if you mount a
*different* host folder there, the manager discovers the engine-side path by
inspecting its own container and translates generated bind mounts
automatically (override with `SELFHELP_ENGINE_ROOT`, see Configuration).
Where this page says `sh-manager ...`, run `shm ...`; for the wizard run
`docker run --rm -p 127.0.0.1:8765:8765 ... web --host 0.0.0.0`
(see "Option A"). Running from a source checkout (`npm run cli -- ...`) is for
development.

## Option A — the web wizard (recommended)

1. Start the wizard on the server (bootstrap mode, localhost only):

```bash
# from the Docker image (binds 0.0.0.0 inside the container; the published
# port stays loopback-only on the server):
docker run --rm -p 127.0.0.1:8765:8765 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/selfhelp:/opt/selfhelp \
  ghcr.io/humdek-unibe-ch/sh-manager:latest web --host 0.0.0.0

# or from a source checkout:
sh-manager web --root /opt/selfhelp
# "SelfHelp Manager bootstrap UI listening on http://127.0.0.1:8765"
```

2. From your machine, open an SSH tunnel and browse to it:

```bash
ssh -L 8765:127.0.0.1:8765 you@your-server
# then open http://127.0.0.1:8765
```

3. Work through the wizard:
   - **Welcome → Mode**: choose *Production server* or *Local Docker test*, and
     set a **server id**.
   - **Preflight**: run the Docker, internet, registry, and resource checks. Each
     must pass (or warn) before you can continue. Nothing is created yet.
   - **Domain**: production = public domain (+ Let's Encrypt email); local =
     localhost port. Production validates DNS before installing.
   - **Instance**: display name, instance id, release channel, version, registry.
   - **Review**: confirm, then **Install**. The wizard creates Docker resources
     and writes files, runs provisioning, and shows a success screen.

4. On success the wizard shows the public URL, the important paths, and — when
   you configured an admin email — the **generated admin password**, masked
   behind a *Reveal* button and shown **once** (it disappears when you leave or
   reload the page). The same password is also saved on the server in the
   owner-only file `<instance>/secrets/admin_password`; store it in your
   password manager and delete the file after your first sign-in.

The wizard **self-locks** after a successful install: the installer can no longer
change anything. To manage the server afterwards, run it in **persistent mode**
(see [security hardening](security-hardening.md)).

## Option B — the CLI

### 1. Bootstrap the server (once)

```bash
sh-manager server init --server-id srv-001 --mode production --email ops@example.ch
# Proxy compose: /opt/selfhelp/proxy/compose.yaml
# Inventory:     /opt/selfhelp/selfhelp.server.json
```

This writes the server inventory, creates the shared `selfhelp_proxy` Docker
network, and (production mode) starts the single shared Traefik proxy. Local
mode creates the network but starts no proxy container — local instances are
reached directly on their published ports. Re-running on an existing install
requires `--import` to acknowledge repair.

### 2. Check the host

```bash
sh-manager doctor
```

Runs the host resource preflight (disk, memory, CPU, ports 80/443, Docker +
Compose availability).

### 3. Install an instance

Install and bring the stack up (the official registry is the default;
`--registry <url>` overrides it for dev/test registries):

```bash
sh-manager instance install --id website1 --domain website1.example.ch \
  --version latest --up
```

Install **and fully provision** (wait for DB → migrate → create admin → install
plugins → warm caches → health-check). A strong admin password is generated and
printed **once** if you do not pass one:

```bash
sh-manager instance install --id website1 --domain website1.example.ch \
  --version latest --provision --admin-email ops@example.ch
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--mode production\|local` | Production (domain + TLS) or local (localhost port). |
| `--port <n>` | Localhost port (local mode). |
| `--registry <url>` | Registry base URL (default: the official registry). Signature verification against the pinned trusted keys applies regardless. |
| `--strict-dns` | Production: **block** (not just warn) when DNS does not resolve here. |
| `--channel stable\|beta\|nightly` | Registry channel. |
| `--version <v>` | Core version, or `latest`. |
| `--admin-password <pw>` | Provide the admin password instead of generating one. |
| `--plugin-manifest <path...>` | Plugin `plugin.json` paths to install during provisioning. |

A **generated** admin password is printed once **and** saved to the owner-only
file `<instance>/secrets/admin_password` (0600), so it survives a closed
terminal or a resumed install — a retried install reuses it instead of
regenerating. Store it in your password manager and delete the file after your
first sign-in. A password you supply yourself via `--admin-password` is used
as-is and never written to disk. Neither ever enters the manifest, lock file,
inventory, or logs.

### 4. Verify

```bash
sh-manager instance list
sh-manager instance health website1
```

## What gets created

Per instance, under `<root>/instances/<id>/` (root default `/opt/selfhelp`):

| File | Purpose |
| --- | --- |
| `compose.yaml` | The instance stack (no container mounts the Docker socket). |
| `.env` | Non-secret environment only. |
| `manifest.json` | What was installed (no secrets). |
| `lock.json` | Pinned image digests + versions. |
| `README.md` | Operator commands for this instance. |
| `backups/` | Checksummed backups. |

Persistent data (database, uploads, plugin artifacts, secrets) lives in Docker
volumes that **survive** updates and removals unless you explicitly full-delete.

## Configuration

| Env var | Purpose |
| --- | --- |
| `SELFHELP_ROOT` | Root directory (default `/opt/selfhelp`). |
| `SELFHELP_ENGINE_ROOT` | The Docker engine's view of the root when it differs from the manager container's (auto-discovered by self-inspection when containerized; set explicitly only if discovery is impossible, `off` disables translation). |
| `SELFHELP_TRUSTED_KEYS` | Path to the registry trusted-keys file. Default: the pinned official production key shipped in the image (`packages/schemas/keys/official-trusted-keys.json`), so installs from the official registry verify out of the box. Override only for dev/test registries. |
| `SELFHELP_PUBLIC_IP` | Optional: enables a hard server-IP DNS comparison. |
| `SHM_WEB_HOST` / `SHM_WEB_PORT` | Web BFF bind host/port (default `127.0.0.1:8765`). |

## Next steps

- [Update an instance](update.md)
- [Back up and restore](backup-restore.md)
- [Security hardening](security-hardening.md)
