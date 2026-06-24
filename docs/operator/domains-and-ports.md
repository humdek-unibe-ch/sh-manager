# Domains, DNS and local ports

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `1.2.0+`)
Last verified: 2026-06-23
Source of truth: `apps/cli/src/actions.ts` (`instanceSetAddress`), `packages/docker/src/compose.ts`, `packages/docker/src/env.ts`, `apps/web/src/ui/features/manager/SetAddressDialog.tsx`

Every instance is reachable at exactly one address, decided by its mode:

- **Production** — a public **domain** routed by the shared Traefik proxy with
  an automatic Let's Encrypt TLS certificate. Realtime events (Mercure) are
  served on the same domain under `/.well-known/mercure`.
- **Local** — a **localhost port** published on `127.0.0.1` only (reach it
  through an SSH tunnel from your machine).

This page covers how to set up DNS for a production instance, and how to
change an instance's domain or port later — from the manager GUI or the CLI.

## DNS setup for a production instance

Do this **before** installing (or before switching an instance to a new
domain):

1. In your DNS provider, create an **A** record (and **AAAA** if the server
   has IPv6) for the hostname, pointing at the server's public IP:

   ```text
   site.example.org.    A      203.0.113.10
   site.example.org.    AAAA   2001:db8::10   (optional)
   ```

2. Wait for the record to resolve (usually minutes; TTL-dependent):

   ```bash
   dig +short site.example.org
   # → 203.0.113.10
   ```

3. Make sure ports **80 and 443** on the server are reachable from the
   internet — Let's Encrypt validates over HTTP/TLS and the proxy serves
   traffic on those ports.

The TLS certificate is **not** requested at install time: Traefik obtains it
automatically from Let's Encrypt on the first request for the domain. If DNS
is wrong, the site stays unreachable and certificate issuance fails quietly —
fix the record and it recovers on its own (no restart needed).

The install and address-change flows check DNS and **warn** when the hostname
does not resolve to this server (use `--strict-dns` on the CLI to turn the
warning into a hard block).

## Change an instance's address from the GUI

Open the instance in the operations console and click **Change address…**.

- Production instances ask for the **new domain** (set up DNS first — see
  above).
- Local instances ask for the **new local port** (1024–65535, published on
  `127.0.0.1` only).

The dialog explains what happens, then **Apply & restart**:

1. The manager rewrites the instance's generated configuration (compose file,
   environment, routing labels — including the Mercure realtime route) for
   the new address. Versions, data and secrets stay untouched.
2. The containers are recreated (`docker compose up -d`) so the new address
   takes effect. Expect roughly a minute of downtime.
3. The operation is journaled like every other action — watch the live log in
   the GUI, and find the result in the instance's operation history.

The old domain stops being routed immediately; the new TLS certificate is
issued automatically on first traffic.

## Change an instance's address from the CLI

```bash
# production: move to a new domain (DNS must already point here)
sh-manager instance set-address website1 --domain new.example.org

# local: publish on a different localhost port
sh-manager instance set-address localtest --port 9200

# write the new config only; apply later with docker compose up -d
sh-manager instance set-address website1 --domain new.example.org --no-restart

# block (instead of warn) when DNS does not resolve to this server
sh-manager instance set-address website1 --domain new.example.org --strict-dns
```

The command prints the previous and the new address, whether the containers
were restarted, and the health snapshot after the restart. Re-applying the
**same** address is allowed and is a supported repair path: it regenerates
the config from the lock file and restarts — useful when a compose file was
hand-edited or corrupted.

Domains already used by another instance on the same server are refused.

## How the address is wired (reference)

| Mode | Frontend | Realtime (Mercure) | Mobile preview (optional) |
| --- | --- | --- | --- |
| Production | Traefik routes `https://<domain>` → frontend container | Traefik routes `https://<domain>/.well-known/mercure` → Mercure container | Traefik routes `https://<domain>/mobile-preview` → mobile-preview container |
| Local | `127.0.0.1:<port>` → frontend container | Frontend BFF proxies events to the internal `http://mercure/.well-known/mercure` hub | `127.0.0.1:<port>/mobile-preview` → mobile-preview container |

In production, the browser and the mobile app subscribe to the public
`https://<domain>/.well-known/mercure` URL. In local mode there is no public
hub URL — events flow through the frontend's own `/api/auth/events` endpoint,
which talks to the Mercure container over the instance's private Docker
network.

When the optional **mobile preview** service is enabled, Traefik routes
`/mobile-preview` on the **same domain/port** to the `selfhelp-mobile-preview`
container; the CMS page editor embeds that path in an iframe. The container's
in-process proxy reaches the backend over the **private** Docker network, so no
extra public backend port is opened. The backend remains unrouted by Traefik in
both modes (it is reached only by the frontend and the mobile-preview proxy over
the internal network).

## Troubleshooting

- **Site unreachable after a domain change** — check `dig +short <domain>`
  resolves to this server; check ports 80/443 are open. Traefik retries the
  certificate automatically once DNS is correct.
- **Browser warns about an invalid certificate right after the change** —
  Let's Encrypt issuance takes a few seconds after the first request; reload.
  If it persists, check the proxy container logs:
  `docker logs selfhelp-proxy 2>&1 | grep -i acme | tail -20`.
- **`/api/auth/events` fails on a local instance** — run a health check from
  the instance page; if the Mercure container is down, restart the instance
  (`Change address…` with the same port, or `docker compose up -d` in the
  instance directory).
- **"Domain already used by instance …"** — every domain can route to exactly
  one instance per server; pick another hostname or remove the conflicting
  instance first.

## See also

- [Reverse proxy & Apache](reverse-proxy-and-apache.md) — why the bundled
  Traefik proxy must own ports 80/443, and what to do when an existing
  Apache/nginx is already on them (the usual "domain does not load / no SSL").
- [GUI instance management](gui-instance-management.md) — the operations
  console, including the Change address dialog.
- [Install](install.md) — choosing production vs local mode at install time.
- [Clone & remove](clone-remove.md) — clones get their own domain/port.
- [Troubleshooting](troubleshooting.md) — general symptom → fix tables.
