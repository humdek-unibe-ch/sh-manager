# Install a server and your first instance

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`, installs SelfHelp 8.x)
Last verified: 2026-06-08
Source of truth: `apps/cli/src/bin.ts`, `apps/web/src/bin.ts`, `apps/web/src/server.ts`

This installs SelfHelp on a fresh server in two stages: **bootstrap the server**
(one shared reverse proxy + an inventory) and **install an instance** (an
isolated SelfHelp site). You can do both from the **web wizard** or the **CLI**.

## Before you start

- A Linux server with **Docker Engine + Docker Compose v2**.
- For a production install: a **domain name** whose DNS points at this server,
  and ports **80/443** free.
- The manager runs as the only privileged tool. Do not expose the wizard to the
  internet — it binds to `127.0.0.1`; reach it over an **SSH tunnel** for a
  remote server.

## Option A — the web wizard (recommended)

1. Start the wizard BFF on the server (bootstrap mode, localhost only):

```bash
sh-manager-web --root /opt/selfhelp
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

4. On success the wizard shows the public URL, the important paths, and tells you
   to retrieve the **generated admin password** from the server (it is written to
   a restricted file and shown by the install process **once** — never displayed
   in the UI).

The wizard **self-locks** after a successful install: the installer can no longer
change anything. To manage the server afterwards, run it in **persistent mode**
(see [security hardening](security-hardening.md)).

## Option B — the CLI

### 1. Bootstrap the server (once)

```bash
sh-manager server init --server-id srv-001 --mode production --email ops@example.ch
# Proxy compose: /opt/selfhelp/proxy/docker-compose.yml
# Inventory:     /opt/selfhelp/inventory.json
```

This creates the single shared Traefik proxy and the server inventory. Re-running
on an existing install requires `--import` to acknowledge repair.

### 2. Check the host

```bash
sh-manager doctor
```

Runs the host resource preflight (disk, memory, CPU, ports 80/443, Docker +
Compose availability).

### 3. Install an instance

Install and bring the stack up:

```bash
sh-manager instance install --id website1 --domain website1.example.ch \
  --registry https://humdek-unibe-ch.github.io/sh2-plugin-registry/ \
  --version latest --up
```

Install **and fully provision** (wait for DB → migrate → create admin → install
plugins → warm caches → health-check). A strong admin password is generated and
printed **once** if you do not pass one:

```bash
sh-manager instance install --id website1 --domain website1.example.ch \
  --registry https://humdek-unibe-ch.github.io/sh2-plugin-registry/ \
  --version latest --provision --admin-email ops@example.ch
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--mode production\|local` | Production (domain + TLS) or local (localhost port). |
| `--port <n>` | Localhost port (local mode). |
| `--strict-dns` | Production: **block** (not just warn) when DNS does not resolve here. |
| `--channel stable\|beta\|nightly` | Registry channel. |
| `--version <v>` | Core version, or `latest`. |
| `--admin-password <pw>` | Provide the admin password instead of generating one. |
| `--plugin-manifest <path...>` | Plugin `plugin.json` paths to install during provisioning. |

The generated admin password is **never** written to the manifest or lock file.
Store it in your password manager immediately.

### 4. Verify

```bash
sh-manager instance list
sh-manager instance health website1
```

## What gets created

Per instance, under `<root>/instances/<id>/` (root default `/opt/selfhelp`):

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | The instance stack (no container mounts the Docker socket). |
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
| `SELFHELP_TRUSTED_KEYS` | Path to the registry trusted-keys file. |
| `SELFHELP_PUBLIC_IP` | Optional: enables a hard server-IP DNS comparison. |
| `SHM_WEB_HOST` / `SHM_WEB_PORT` | Web BFF bind host/port (default `127.0.0.1:8765`). |

## Next steps

- [Update an instance](update.md)
- [Back up and restore](backup-restore.md)
- [Security hardening](security-hardening.md)
