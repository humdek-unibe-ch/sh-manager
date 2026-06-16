<!--
SPDX-FileCopyrightText: 2026 Humdek, University of Bern
SPDX-License-Identifier: MPL-2.0
-->

# Reverse proxy, ports 80/443 and an existing Apache/nginx

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `1.5.3+`, production mode with real domains + TLS)
Last verified: 2026-06-16
Source of truth: `packages/traefik/src/index.ts`, `packages/docker/src/compose.ts`, `apps/cli/src/actions.ts` (`serverInit`, `ensureProxyRunning`, `serverStartProxy`), `packages/core/src/preflight.ts`

> Command names: on a Docker-only install you run the manager through the `shm`
> alias/wrapper from [install](install.md) (e.g. `shm server start`). The
> in-image binary is `sh-manager`; this page writes `shm` for the commands you
> type and `sh-manager` only when naming the tool itself. `docker ...` and
> system commands are unaffected.

Short version: **SelfHelp ships its own reverse proxy** (a shared
[Traefik](https://traefik.io/) container) that terminates TLS and routes every
instance by domain. In production it **must own ports 80 and 443** on the host.
You do **not** need Apache (or nginx), and if one of them is already listening
on 80/443 your instance domain will not load and no certificate will be issued.

## Why the domain does not load / SSL is missing

When you install a production instance with a domain:

- The manager starts one shared **Traefik** proxy that binds host ports **80**
  and **443** and obtains a **Let's Encrypt** certificate automatically on the
  first request for each domain.
- Each instance's frontend (and the Mercure realtime hub) is routed by Traefik
  using `Host(\`your-domain\`)` labels on the instance's private network. The
  instance containers are **not** published on any host port in production —
  Traefik is the only entry point.

If **Apache or nginx already listens on 80/443**, two ports cannot be shared:

- Either the manager's Traefik proxy fails to start (`Bind for 0.0.0.0:443
  failed: port is already allocated`), so nothing routes your domain, or
- Apache/nginx answers the request itself (its default page or a 404) and, with
  no certificate for your domain, the browser shows a TLS error or plain HTTP.

Either way the symptom is the one you saw: **the SelfHelp instance does not
appear and HTTPS is not set up.** `sh-manager doctor` reports ports 80/443 as
in use in this situation.

## Do you need Apache at all?

For a host dedicated to SelfHelp: **no.** Traefik is the web server and the
reverse proxy. Remove or disable Apache and let Traefik own 80/443. This is the
supported, recommended setup.

Keep Apache only if this host **also** serves other, non-SelfHelp sites that
you cannot move. See [Option B](#option-b-you-must-keep-apache-on-this-host).

## Option A (recommended): let Traefik own 80/443

1. **See what is holding the ports** (run as root):

   ```bash
   sudo ss -ltnp 'sport = :80'
   sudo ss -ltnp 'sport = :443'
   ```

   A line mentioning `apache2`/`httpd` (or `nginx`) is your conflict.

2. **Stop and disable Apache** so it does not come back after a reboot:

   ```bash
   sudo systemctl disable --now apache2     # Debian/Ubuntu (use httpd on RHEL/Alma)
   ```

   (Use `nginx` in place of `apache2` if nginx is the holder.)

3. **Confirm 80/443 are now free:**

   ```bash
   sudo ss -ltnp 'sport = :80'   # should print no listener
   shm doctor                    # the ports check should pass
   ```

4. **Start the shared proxy** (the most common missing piece — see the note
   below). This is idempotent and safe to run any time:

   ```bash
   shm server start
   # → "Shared Traefik proxy (re)started on network \"selfhelp_proxy\"."
   ```

   Then confirm it is running and serving 80/443:

   ```bash
   docker compose -f /opt/selfhelp/proxy/compose.yaml ps   # traefik should be Up
   ```

   If the instance itself also needs recreating, re-apply its address (this now
   ensures the proxy is up too):

   ```bash
   shm instance set-address <id> --domain <your-domain>   # same domain is a valid repair
   ```

   The certificate is issued automatically on the first request once DNS and
   ports are correct (see the checklists below).

> **Why the proxy might be down.** The proxy is started by the first
> `server init`. If that first bring-up failed (an older manager's network bug,
> or Apache holding 80/443 at the time), the server still recorded itself as
> initialized, so later installs skipped init and the proxy never came up —
> `docker compose -f /opt/selfhelp/proxy/compose.yaml ps` shows nothing and every
> instance is unreachable. Manager `1.5.3+` self-heals this on every production
> `instance install` / `set-address` / `enable`; `shm server start` is the
> explicit repair.

## Option B: you must keep Apache on this host

The manager's Traefik proxy always binds **80 and 443** and those ports are not
currently configurable, so Apache and SelfHelp **cannot both use them on the
same IP**. Pick one of these instead — in order of preference:

1. **Move the other sites behind Traefik and drop Apache.** Traefik already
   routes many domains by host; migrating the remaining vhosts to containers (or
   to Traefik file-provider routes) lets one proxy serve everything and is the
   cleanest long-term answer.

2. **Run SelfHelp on its own host or VM.** Give SelfHelp a server (or a small
   VM/LXC) where Traefik can own 80/443, and point the SelfHelp domain's DNS at
   that host. Apache keeps its current server untouched. This is the simplest
   reliable separation when the existing Apache must not change.

3. **Give the host a second public IP for SelfHelp.** Bind Apache to its
   current IP and route the SelfHelp domain's DNS to the second IP. This keeps
   both on one box but needs careful, host-specific networking and is **not**
   managed by `sh-manager`; treat it as advanced/manual.

Putting Apache **in front** of Traefik as a TLS-terminating reverse proxy is
**not supported today**: it would require Traefik on alternate, non-TLS ports
and Apache owning Let's Encrypt (certbot), which the manager does not configure.
Do not attempt it expecting the built-in automatic-TLS flow to work.

## DNS checklist (production)

Do this **before** (or right after) install; the certificate cannot issue until
DNS is correct.

```bash
dig +short your-domain.example.org    # must return THIS server's public IP
```

- Create an **A** record (and **AAAA** for IPv6) for the hostname pointing at
  the server's public IP.
- DNS can take minutes to propagate. The install/address change **warns** (not
  blocks) on a mismatch unless you pass `--strict-dns`.
- Optionally set `SELFHELP_PUBLIC_IP` so the manager compares against a known
  IP instead of guessing.

## TLS / Let's Encrypt checklist

- A bootstrap contact **email** must have been given to `server init` for
  production (Let's Encrypt account).
- Ports **80 and 443** must be free locally (Option A) **and** reachable from
  the internet — check any cloud/security-group/UFW firewall too, not just the
  host.
- DNS must resolve to this server first (above).
- Watch issuance in the proxy log:

  ```bash
  docker compose -f /opt/selfhelp/proxy/compose.yaml logs --tail=200 | grep -i acme
  ```

- Let's Encrypt rate-limits repeated failures — fix DNS/ports first, then retry,
  rather than reloading in a loop.

## "I updated the manager but still see the old GUI"

The web console is a single-page app. Manager `1.5.2+` serves the app shell with
`Cache-Control: no-cache` (and content-hashed assets as immutable), so a
`sh-manager self-update` is picked up on the next load. If you updated from an
**older** manager, do **one** hard refresh to drop the previously cached shell:

- Chrome/Edge/Firefox: `Ctrl`+`Shift`+`R` (macOS: `Cmd`+`Shift`+`R`).

Also make sure only **one** `sh-manager web` process is running (an old
container left bound to `127.0.0.1:8765` keeps serving the old version), and
that you reach it through the SSH tunnel: `ssh -L 8765:127.0.0.1:8765
you@your-server`, then open `http://127.0.0.1:8765`.

## See also

- [Domains, DNS and local ports](domains-and-ports.md) — DNS setup and changing
  an instance's address.
- [Troubleshooting](troubleshooting.md) — ports 80/443, TLS not issued, DNS,
  and the web-UI sections.
- [Install](install.md) — production prerequisites (domain + free 80/443).
- [Security hardening](security-hardening.md) — keep the console private (SSH
  tunnel), never expose it publicly.
