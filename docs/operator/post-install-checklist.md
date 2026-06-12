# Post-install checklist

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`, manages the SelfHelp 0.x pre-release platform line)
Last verified: 2026-06-12
Source of truth: `apps/cli/src/bin.ts`, `apps/web/src/server.ts`, `packages/auth/src`

Work through this **immediately after** a successful install, before you rely on
the instance. It turns a freshly installed instance into a safely operated one:
secrets stored, access locked down, backups scheduled, monitoring in place.

`<root>` defaults to `/opt/selfhelp`; `website1` is the example instance id.

## 1. Secure the credentials

- [ ] **Store the generated admin password** in your password manager, then
      **delete its server-side file**. It was shown **once** at install (CLI
      output / wizard success screen) and saved to the owner-only file
      `<root>/instances/website1/secrets/admin_password`; it is never written
      to the manifest, lock file, or logs. If you lost both, create a new
      admin in the backend container rather than digging for it:

```bash
docker compose -f <root>/instances/website1/compose.yaml \
  exec backend php bin/console <create-admin-command>
```

- [ ] The per-instance manager token for CMS-requested updates is **generated
      at install** and stored in the instance's secrets env — nothing to set up.
      (Instances installed by a manager `< 0.1.6`: run
      `sh-manager instance update <id>` or `sh-manager instance repair <id>`
      once to backfill it.)
- [ ] Confirm `SELFHELP_TRUSTED_KEYS` is unset (the manager defaults to the
      pinned official production key) or points at the official trusted-keys
      file so only signed releases are accepted.

## 2. Verify the install is healthy

```bash
sh-manager instance list
sh-manager instance health website1
curl -fsS https://website1.example.ch/health   # public readiness probe via the BFF
```

- [ ] `instance list` shows the instance running.
- [ ] `instance health` is green for the components you use.
- [ ] The public URL serves over HTTPS (certificate issued). If not, see
      [troubleshooting](troubleshooting.md#tls-certificate-not-issued-https-fails).

## 3. Lock down management access

The bootstrap wizard self-locks after install. Switch to authenticated
**persistent mode** for ongoing management and create least-privilege operators.

```bash
# first run only: issue a one-time token to unlock operator creation
sh-manager admin bootstrap-token --ttl 3600

# create the owner, then add operators with the narrowest role they need
sh-manager admin create --email ops@example.ch --roles server_owner --name "Ops"
sh-manager admin role grant teammate@example.ch instance_operator
```

- [ ] Persistent-mode BFF is **not** internet-exposed (reach it via SSH tunnel).
- [ ] Operators created with least privilege (`server_owner` /
      `instance_operator` / `read_only`).
- [ ] Work through the full [security hardening](security-hardening.md) checklist.

## 4. Schedule backups (and store them off-box)

Updates back up automatically, but you still want regular, independent backups.

```bash
sh-manager instance backup website1   # confirm a manual backup succeeds first
```

- [ ] Add a scheduled backup (cron / systemd timer), e.g. daily:

```cron
# /etc/cron.d/selfhelp-backup-website1
0 3 * * *  root  sh-manager instance backup website1 >> /var/log/selfhelp-backup.log 2>&1
```

- [ ] **Copy backups off the server** (another host / object storage). A backup
      that only lives on the same box does not survive a disk failure.
- [ ] Note your retention policy and prune old local backups (they are plain
      directories under `<root>/instances/<id>/backups/`).

## 5. Wire CMS-requested updates (optional but recommended)

If admins should be able to request updates from the CMS, something must drain
the requested operations. Either of these works:

- Keep the **persistent web UI** running — it drains all instances
  automatically every 15 s and journals each run (see
  [GUI instance management](gui-instance-management.md)).
- Headless: schedule the per-instance processor (it execs into the backend
  container — no URL or token to configure):

```bash
sh-manager instance process-operations website1
```

- [ ] A drain loop is in place (resident GUI, or cron / systemd per instance —
      see [`deploy/`](../../deploy/README.md)).
- [ ] The CMS System page shows the **manager loop** as seen recently.

## 6. Set up monitoring

- [ ] Poll the public readiness probe and alert on non-200:
      `GET https://website1.example.ch/health`.
- [ ] Run `sh-manager instance health website1` and `sh-manager doctor` on a
      timer (catches degraded components, low disk, port issues early).
- [ ] Watch **disk usage** — backups, images, and logs grow over time (see
      [troubleshooting: out of disk space](troubleshooting.md#out-of-disk-space)).
- [ ] Optionally surface the in-CMS **`/admin/system`** view (version, health,
      advisories, maintenance/safe-mode) to your admins.

## 7. Document the instance

- [ ] Record: instance id, domain, registry + channel + installed version, root
      path, where the admin password and manager token are stored, and the backup
      schedule/location. The generated `<root>/instances/website1/README.md` is a
      good anchor for instance-specific commands.

## Next

- [Operations runbook](operations-runbook.md) — the day-to-day lifecycle.
- [Quick reference](quick-reference.md) — the command cheat-sheet.
- [Update](update.md) · [Backup & restore](backup-restore.md) · [Security hardening](security-hardening.md).
