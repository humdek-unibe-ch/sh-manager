# Connect to an instance's MySQL (CLI and Workbench)

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`)
Last verified: 2026-06-15
Source of truth: `packages/docker/src/compose.ts` (`mysql` service, network name), `packages/instances/src/secrets.ts` (DB credential keys)

Each instance runs its own MySQL container. For security the database port is
**not published to the host** — `mysql` is reachable only on the instance's
private Docker network (`selfhelp_<id>_instance`, host `mysql:3306`). That keeps
the database off the public internet; the manager itself talks to it over that
internal network, never a host port.

This guide shows two ways to reach it for inspection/testing: the quick CLI
(works the same on Windows and Linux servers) and MySQL Workbench (or any GUI)
over an SSH tunnel.

`<root>` is the SelfHelp root (default `/opt/selfhelp`); `<id>` is the instance
id (for example `website1`). Run the server-side commands on the server.

## Where the credentials live

The generated database credentials are in the instance's restricted secrets
file: `<root>/instances/<id>/secrets/secrets.env`. The relevant keys are:

| Key | What |
| --- | --- |
| `MYSQL_DATABASE` | The application schema name. |
| `MYSQL_USER` / `MYSQL_PASSWORD` | The non-privileged application account. |
| `MYSQL_ROOT_PASSWORD` | The `root` account (use only when you must). |

> These are secrets. Read them on the server; do not paste them into chat,
> tickets, screenshots, or shared notes. Prefer the application user
> (`MYSQL_USER`) over `root` for day-to-day inspection.

## Method 1 — quick CLI (no GUI, server-side)

This never prints the password — it uses the variables already set inside the
container. Identical on a Windows or Linux server (PowerShell, bash, or `cmd`):

```bash
docker compose -f <root>/instances/<id>/compose.yaml exec mysql \
  sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
```

For an administrative session use root:

```bash
docker compose -f <root>/instances/<id>/compose.yaml exec mysql \
  sh -lc 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
```

A one-off query (example: list tables):

```bash
docker compose -f <root>/instances/<id>/compose.yaml exec mysql \
  sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -e "SHOW TABLES;" "$MYSQL_DATABASE"'
```

## Method 2 — MySQL Workbench (or DBeaver/TablePlus) over SSH

Because the port is private, you (1) expose it temporarily on the **server's
loopback only**, then (2) tunnel that loopback port to your workstation over SSH.
Nothing is ever opened to the public network.

### Step 1 — temporarily expose MySQL on the server loopback

On the server, start a throwaway forwarder attached to the instance network. It
binds to `127.0.0.1` only (not `0.0.0.0`), so it is not reachable from outside:

```bash
docker run --rm -d --name <id>-db-tunnel \
  --network selfhelp_<id>_instance \
  -p 127.0.0.1:13306:3306 \
  alpine/socat tcp-listen:3306,fork,reuseaddr tcp-connect:mysql:3306
```

The instance MySQL is now at `127.0.0.1:13306` **on the server**.

### Step 2 — tunnel the port to your workstation

Open an SSH tunnel from your machine. Leave it running while you use Workbench.

- Linux / macOS (and Windows PowerShell — OpenSSH ships with Windows 10/11):

```bash
ssh -N -L 13306:127.0.0.1:13306 operator@your-server
```

- Windows with PuTTY (if you do not use the built-in OpenSSH): in
  Connection → SSH → Tunnels add Source port `13306`, Destination
  `127.0.0.1:13306`, click **Add**, then open the session.

### Step 3 — create the Workbench connection

New connection → Connection Method: **Standard (TCP/IP)**:

| Field | Value |
| --- | --- |
| Hostname | `127.0.0.1` |
| Port | `13306` |
| Username | `MYSQL_USER` (or `root`) |
| Password | the matching value from `secrets.env` |
| Default Schema | `MYSQL_DATABASE` |

> Prefer fewer moving parts? MySQL Workbench can do the SSH hop itself: pick
> **Standard TCP/IP over SSH**, set SSH Hostname `your-server:22` + SSH
> Username, then MySQL Hostname `127.0.0.1` and MySQL Server Port `13306`
> (resolved on the server, where the Step 1 forwarder listens). Then you can
> skip Step 2.

### Step 4 — clean up

When you are done, remove the forwarder (and close the SSH tunnel):

```bash
docker rm -f <id>-db-tunnel
```

## Notes

- The forwarder and the open port disappear as soon as you remove the
  `<id>-db-tunnel` container — keep it up only while you need it.
- Writing directly to the database bypasses the application. For anything other
  than read-only inspection, prefer the CMS, the manager, or a backup/restore.
- Backups already capture the database (`sh-manager instance backup <id>`); use
  them rather than manual `mysqldump` when you want a portable copy.
