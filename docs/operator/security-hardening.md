# Security hardening

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`)
Last verified: 2026-06-12
Source of truth: `apps/web/src/server.ts`, `apps/cli/src/bin.ts`, `packages/auth/src`, `packages/docker/src/guards.ts`

The manager is the single privileged tool on the server. Treat its access as
root-equivalent. This page is the production checklist plus the model behind it.

## The model

- **`sh-manager` owns Docker**; the CMS never controls Docker directly.
- **No runtime container mounts the Docker socket.** Only the shared Traefik proxy
  receives it, read-only. This is enforced by `@shm/docker` guards.
- **Signed, trusted releases only.** Releases are Ed25519-signed and
  SHA-256-checksummed; the client refuses unsigned, untrusted, or `dev`-keyed
  releases in production. There is exactly **one** official registry.
- **Instance isolation.** Each instance has its own secrets; clones and
  clone-restores get fresh secrets. CMS update requests are instance-scoped and
  the backend never trusts a browser-provided `instanceId`.

## Web UI / BFF posture

- The BFF binds to **`127.0.0.1`** by default. A non-loopback bind is refused
  unless you pass `--allow-non-local` explicitly.
- A **Host-header allowlist** defends against DNS-rebinding on every request.
- Every API call requires an authenticated operator **session**, with **CSRF**
  on state-changing requests (`x-shm-csrf`), and an
  `HttpOnly; SameSite=Strict` session cookie.
- The single pre-auth exception is the **first-operator setup**
  (`POST /api/setup/operator`): localhost-only, and rejected with `409` the
  moment any operator exists — afterwards accounts are created only by a
  signed-in `server_owner` or the CLI.
- Every **instance management** action
  (create/update/backup/restore/clone/mailer/remove, see
  [GUI instance management](gui-instance-management.md)) runs through the
  operation **journal** (`<root>/manager/operations/`, secret-redacted logs),
  is appended to the **audit log** (`<root>/manager/audit.jsonl`: operator,
  action, instance, result), and is serialized by a **per-instance lock** —
  one mutating operation per instance at a time.

### Reaching the UI remotely

Do **not** expose the UI to the internet. Use an SSH tunnel:

```bash
ssh -L 8765:127.0.0.1:8765 you@your-server
# open http://127.0.0.1:8765
```

Only set `--allow-non-local` if you front the BFF with your own authenticated,
TLS-terminating proxy.

## Operators

The console authenticates operators against an operator store
(`<root>/manager/operators.json`). The **first** operator is created on the
console's one-time setup screen (localhost-only) or with `admin create`;
manage all operators with the CLI:

```bash
# create a local operator; omitting --password generates a strong one and
# prints it exactly once (or pass --password / SELFHELP_MANAGER_ADMIN_PASSWORD)
sh-manager admin create --email ops@example.ch --roles server_owner --name "Ops"

# roles and lifecycle
sh-manager admin role grant ops@example.ch instance_operator
sh-manager admin disable old.operator@example.ch
sh-manager admin list
```

Authentication is **local only** (email + password). The manager is reached on
the server itself or over an SSH tunnel, so no login port is exposed — there is
no campus/OIDC/SSO sign-in.

Roles: `server_owner`, `instance_operator`, `read_only`. Grant the least
privilege each operator needs. Passwords are hashed; digests are never printed.

## Tokens and keys

| Secret | Where | Notes |
| --- | --- | --- |
| Per-instance manager token | generated at install, stored in the instance's secrets env | Authenticates the manager to one instance's backend (`process-operations`). Unique per instance; backfilled on `instance update`/`repair`. `--token`/`SELFHELP_MANAGER_TOKEN` override it for remote (`--backend-url`) setups. |
| Operator passwords | `--password` / `SELFHELP_MANAGER_ADMIN_PASSWORD` | Used only at creation; stored hashed. |
| Registry trusted keys | `SELFHELP_TRUSTED_KEYS` | The Ed25519 public keys the client trusts. Keep this file under change control. |
| Generated admin password | shown once at install + `<instance>/secrets/admin_password` (0600) | Never in manifest/lock/logs; store it in a password manager and delete the file after the first sign-in. |

Never commit tokens or keys, never paste them into issues, logs, or support
bundles.

## Production checklist

- [ ] Docker Engine + Compose v2 installed; the host passes `sh-manager doctor`.
- [ ] The web console/BFF is **not** internet-exposed; access is via SSH tunnel.
- [ ] Real operator accounts exist with least privilege (the first-run owner
      plus narrow `instance_operator`/`read_only` accounts).
- [ ] `SELFHELP_TRUSTED_KEYS` is **unset** (the default is the pinned official
      production key shipped with the manager) or points at the official
      trusted-keys file; no `dev`-keyed releases are accepted.
- [ ] Each instance has a **unique** per-instance manager token (generated at
      install; older instances backfilled via `instance update`/`repair`).
- [ ] The audit log (`<root>/manager/audit.jsonl`) is reviewed periodically and
      included in your log retention.
- [ ] DNS points at this server; consider `--strict-dns` (and `SELFHELP_PUBLIC_IP`
      for a hard server-IP comparison) for production installs.
- [ ] Backups run on a schedule and are stored off-box.
- [ ] Only the shared proxy has the Docker socket (read-only); no instance
      container does.
- [ ] Support bundles are reviewed before sharing and sent privately.
