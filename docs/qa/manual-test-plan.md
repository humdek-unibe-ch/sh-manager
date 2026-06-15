<!--
SPDX-FileCopyrightText: 2026 Humdek, University of Bern
SPDX-License-Identifier: MPL-2.0
-->

# Manual QA test plan

Audience: QA testers and server operators
Status: Active
Applies to: `sh-manager` (manager tool `1.4.0+`)
Last verified: 2026-06-15
Source of truth: `apps/cli/src/bin.ts`, `apps/web/src`, `e2e/docker-e2e.test.ts`

This is the structured manual test plan for a manager release. It complements —
never replaces — the automated suites: every case links its automated
equivalent, and manual execution focuses on what automation cannot judge
(real browsers, real DNS/TLS, operator ergonomics, true cross-platform Docker
behaviour). Record results in a copy of the
[results template](results-template.md).

How to use this plan:

1. Set up a test server per [Appendix A (Linux)](#appendix-a-linux-setup) or
   [Appendix B (Windows Docker Desktop)](#appendix-b-windows-docker-desktop-setup).
2. Run the suites top to bottom — later suites reuse instances created by
   earlier ones. Cases marked **[destructive]** delete data; run them last or
   against dedicated instances.
3. For every case record pass / fail / blocked plus evidence (command output,
   screenshot) in the results file.

Severity legend:

- **Critical** — failure means data loss, a security hole, or an unusable
  release. Blocks the release.
- **High** — a core operator workflow is broken. Blocks the release unless a
  documented workaround exists.
- **Medium** — degraded UX or a non-core path. Fix or ticket before release.

Conventions used in the steps:

- `website1`, `website2` … are example instance ids; any `[a-z0-9-]` id works.
- Commands are shown as `sh-manager …`; on wrapper installs use
  `./shm.sh <args>` / `.\shm.ps1 <args>` instead (same arguments).
- The web console is `http://127.0.0.1:8765` (wrapper default port).
- Never paste real secrets/DSNs into results files — redact like the UI does.

## Suite overview

| Suite | Area | Cases |
|---|---|---|
| QA-BOOT | Server bootstrap + first-run operator setup | 4 |
| QA-INST | Instance install (GUI wizard + CLI) | 4 |
| QA-AUTH | Multi-instance CMS login isolation | 3 |
| QA-HLTH | Health checks | 3 |
| QA-BKP | Manual backups | 3 |
| QA-SCHED | Scheduled backups + GFS retention | 7 |
| QA-RST | Restore | 4 |
| QA-CLN | Clone | 2 |
| QA-UPD | Update (dry-run / preflight / execute / rollback) | 4 |
| QA-ADDR | Address changes | 2 |
| QA-MAIL | Outbound mail (SMTP DSN) | 3 |
| QA-PLUG | In-CMS plugin operations (managed mode) | 4 |
| QA-SAFE | Safe mode | 2 |
| QA-SUP | Support bundle | 2 |
| QA-GUI | Web console auth + operations | 5 |
| QA-WRAP | Wrapper lifecycle verbs | 3 |
| QA-RMV | Instance remove (3 modes) | 3 |
| QA-PURGE | Server purge | 2 |

---

## QA-BOOT — Server bootstrap

### QA-BOOT-001 — Initialize a fresh server

- **Severity**: Critical
- **Preconditions**: Docker Engine + Compose v2 installed; empty install root.
- **Steps**:
  1. Run `sh-manager server init --server-id qa-test --mode local`.
  2. Run `sh-manager server status`.
- **Expected**: Init reports the created proxy config + inventory.
  `server status` shows the server id, mode `local`, and zero instances. The
  install root contains `selfhelp.server.json` and a `proxy/` folder.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (server init),
  `e2e/docker-e2e.test.ts` scenario 1.

### QA-BOOT-002 — Re-bootstrap is refused without explicit import

- **Severity**: High
- **Preconditions**: QA-BOOT-001 done.
- **Steps**:
  1. Run `sh-manager server init --server-id qa-test --mode local` again.
- **Expected**: The command refuses with "already bootstrapped" and changes
  nothing. With `--import` it reconciles instead and keeps registered
  instances.
- **Automated equivalent**: `apps/cli/src/cli.test.ts`
  ("refuses to re-bootstrap an already-managed server …").

### QA-BOOT-003 — First-run operator setup (web)

- **Severity**: Critical
- **Preconditions**: Fresh server, no operator created yet; web GUI running
  (`./shm.sh up` or `npm -w @shm/web run dev` on a dev machine).
- **Steps**:
  1. Open `http://127.0.0.1:8765` in a browser.
  2. Complete the one-time operator creation form (e-mail + password).
  3. Sign out, sign back in with the new credentials.
- **Expected**: The first-run screen appears only while no operator exists.
  After creation it never re-appears (the setup endpoint answers 409) and the
  login works. The password is never echoed anywhere.
- **Automated equivalent**: `apps/web/src/server.test.ts` (first-run setup),
  `apps/web/src/ui/App.test.tsx`.

### QA-BOOT-004 — First-run setup is localhost-gated

- **Severity**: Critical (security)
- **Preconditions**: As QA-BOOT-003, before creating the operator.
- **Steps**:
  1. From another machine (or with a non-localhost bind), try to open the
     console and create the operator.
- **Expected**: The BFF binds to localhost by default; remote access only
  works through an SSH tunnel. No operator can be created from a remote
  origin without the tunnel.
- **Automated equivalent**: `apps/web/src/server.test.ts` (bind/auth gating).

---

## QA-INST — Instance install

### QA-INST-001 — CLI install with provisioning

- **Severity**: Critical
- **Preconditions**: QA-BOOT-001; outbound HTTPS to the official registry.
- **Steps**:
  1. Run:

```bash
sh-manager instance install \
  --id website1 --name "QA Website 1" \
  --mode local --port 8081 \
  --provision --admin-email qa.admin@selfhelp.test --admin-name "QA Admin"
```

  2. Note the one-time admin password printed at the end.
  3. Open `http://localhost:8081` and log in with the admin credentials.
- **Expected**: Install resolves + verifies the release (checksums and
  Ed25519 signatures), brings the stack up, provisions the database and admin
  user, and prints the admin password exactly once. The CMS login works.
- **Automated equivalent**: `apps/cli/src/smoke.test.ts`,
  `e2e/docker-e2e.test.ts` scenario 1.

### QA-INST-002 — GUI create wizard (full page)

- **Severity**: Critical
- **Preconditions**: Web console signed in.
- **Steps**:
  1. In the console choose "Create instance".
  2. Walk through the wizard: id, display name, mode/port (or domain),
     version/channel, provisioning options, optional SMTP DSN (leave empty to
     use the bundled Mailpit).
  3. Submit and watch the operation in the console.
- **Expected**: Validation blocks bad inputs (duplicate id, invalid port)
  with actionable messages. The operation journal streams progress, ends
  "succeeded", and the new instance appears in the list with health "healthy".
  The generated admin password is shown once and never again.
- **Automated equivalent**:
  `apps/web/src/ui/features/manager/InstanceManagement.test.tsx`,
  `apps/web/src/actions.test.ts`.

### QA-INST-003 — Install refuses a tampered release

- **Severity**: Critical (security)
- **Preconditions**: A locally served registry copy you can edit (developer
  setup, see `e2e/build-test-registry.mjs`).
- **Steps**:
  1. Serve a registry whose release JSON was modified after signing (flip one
     byte in an image digest).
  2. Run `sh-manager instance install --id tampered … --registry <url>`.
- **Expected**: Signature verification fails; the install aborts before
  anything is pulled or created. The error names the failed verification.
- **Automated equivalent**: `packages/registry/src/*.test.ts`
  (signature/checksum failure paths).

### QA-INST-004 — Two instances are isolated

- **Severity**: Critical
- **Preconditions**: QA-INST-001 done.
- **Steps**:
  1. Install `website2` on another port (same steps as QA-INST-001).
  2. Compare `docker volume ls` entries for both instances.
  3. Log in to each CMS separately.
- **Expected**: Each instance has its own compose project, volumes, network
  and secrets; no volume name overlaps. Both CMS logins work independently.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 8.

---

## QA-AUTH — Multi-instance CMS login isolation

These cases target the bug where several instances served on the same host
(`localhost:<port>`) shared ONE browser cookie jar (cookies are scoped by host,
not port), so logging into — or updating — one instance silently logged the
operator out of the others. Each instance now namespaces its httpOnly session
cookies (`sh_auth_<id>`, `sh_refresh_<id>`, `sh_impersonate_<id>`) by
`SELFHELP_INSTANCE_ID`. Run these with at least two instances on different ports
(reuse `website1` from QA-INST-001 and `website2` from QA-INST-004), each with
an admin account.

### QA-AUTH-001 — Logging into one instance never logs out another

- **Severity**: Critical (regression)
- **Preconditions**: `website1` and `website2` running on different local ports.
- **Steps**:
  1. In one browser profile, log into `website1`'s CMS admin.
  2. In a second tab (same profile), log into `website2`'s CMS admin.
  3. Return to the `website1` tab and open an admin page.
  4. In DevTools → Application → Cookies, inspect both origins.
- **Expected**: Both sessions stay logged in. `website1` carries
  `sh_auth_website1` and `website2` carries `sh_auth_website2` (distinct names);
  neither overwrites the other. (`sh_csrf` may be shared across ports — that is
  expected and harmless.)
- **Automated equivalent**: `src/config/cookie-names.test.ts` (frontend).

### QA-AUTH-002 — Update/restart of one instance keeps its own session

- **Severity**: High
- **Steps**:
  1. Logged into `website1`, run an update or `docker restart` of its backend.
  2. While it restarts, keep the `website1` tab open; refresh once it is back.
  3. Confirm the untouched `website2` is still logged in.
- **Expected**: `website1` recovers WITHOUT a forced re-login — the BFF treats a
  briefly-unreachable backend as transient (503, session kept) and silently
  refreshes once it is back. `website2` is unaffected. Neither bounces to
  `/login`.
- **Automated equivalent**: `src/config/__tests__/server.config.refresh.test.ts`
  (unreachable vs invalid), `src/config/cookie-names.test.ts`.

### QA-AUTH-003 — Access token silently renews from the 30-day refresh token

- **Severity**: High
- **Steps**:
  1. Log into `website1`.
  2. Let the session sit idle past the access-token TTL (default 1h; for a fast
     check, lower `JWT_TOKEN_TTL` on a throwaway instance).
  3. Navigate to an admin page after the access TTL has elapsed.
- **Expected**: The page renders without a re-login — the proxy/BFF rotates the
  access token using the refresh token transparently. The operator only lands on
  `/login` once the 30-day refresh token itself is missing/expired.
- **Automated equivalent**: `src/config/__tests__/server.config.refresh.test.ts`.

---

## QA-HLTH — Health

### QA-HLTH-001 — Healthy instance reports healthy

- **Severity**: High
- **Steps**:
  1. Run `sh-manager instance health website1`.
  2. Open the instance detail in the web console.
- **Expected**: CLI prints per-service probes (backend, frontend, …) all OK
  and `overall: healthy`. The console shows the same verdict (it probes
  through the real frontend BFF path).
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 1,
  `apps/web/src/server.test.ts` (health route).

### QA-HLTH-002 — Stopped service is detected

- **Severity**: High
- **Steps**:
  1. Stop one service manually: `docker stop <project>-backend-1`.
  2. Run `sh-manager instance health website1`.
  3. Start it again (`docker start …`) and re-check.
- **Expected**: Health degrades with the failing probe named; after restart
  the verdict returns to healthy.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (health mapping).

### QA-HLTH-003 — The `volume-init` container is expected to be "Exited (0)"

- **Severity**: Medium
- **Steps**:
  1. Run `docker ps -a` (or open Docker Desktop) for an instance project.
  2. Note the `…-volume-init-1` container's status.
  3. Run `sh-manager instance health website1`.
- **Expected**: `…-volume-init-1` shows `Exited (0)` — it is a one-shot that
  hands ownership of the data volumes to the app user and then exits; the
  Symfony services gate on its successful completion. An `Exited (0)` init
  container is HEALTHY, not a half-running stack, and the manager's health
  verdict (which probes the HTTP surface, not this container's Docker flag)
  reports `healthy`. Only a NON-zero exit code is worth investigating.
- **Automated equivalent**: `packages/docker/src/compose.test.ts`
  (`volume-init` + `service_completed_successfully` gate).

---

## QA-BKP — Manual backups

### QA-BKP-001 — Create a manual backup

- **Severity**: Critical
- **Steps**:
  1. Create some content in the CMS (a page or a form entry).
  2. Run `sh-manager instance backup website1`.
  3. Inspect `instances/website1/backups/<backupId>/`.
- **Expected**: The backup directory contains `backup-manifest.json`,
  `database.sql`, volume archives and secrets/config copies. The manifest
  lists every file with a SHA-256 checksum and carries `origin: "manual"`.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (backup),
  `packages/backup/src/backup.test.ts`.

### QA-BKP-002 — Same-day backups never collide

- **Severity**: Critical (regression)
- **Steps**:
  1. Run `sh-manager instance backup website1` twice on the same day.
- **Expected**: Two distinct backup directories exist (`…-1`, `…-2`); the
  first is not overwritten.
- **Automated equivalent**: `apps/cli/src/cli.test.ts`
  ("two same-day backups get distinct sequence numbers …").

### QA-BKP-003 — GUI backup with origin badge

- **Severity**: Medium
- **Steps**:
  1. In the web console open Backups for `website1`.
  2. Trigger a backup from the GUI; wait for the operation to finish.
- **Expected**: The new backup appears in the list with a "Manual" origin
  badge; scheduled/pre-update/pre-restore backups (from later suites) show
  their own badges.
- **Automated equivalent**:
  `apps/web/src/ui/features/manager/BackupManager.test.tsx`.

---

## QA-SCHED — Scheduled backups + GFS retention

Read [the scheduled-backups runbook](../operator/scheduled-backups.md) first.

### QA-SCHED-001 — Enable a schedule (CLI + GUI agree)

- **Severity**: High
- **Steps**:
  1. Run `sh-manager instance backup-schedule website1 --enable --time 02:30
     --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --max-age-days 365`.
  2. Run `sh-manager instance backup-schedule website1` (no flags = show).
  3. Open the Backups panel in the web console.
- **Expected**: CLI and GUI show the same policy, the next planned run time,
  and the projected disk footprint. The policy is stored in the instance
  manifest (schema-validated).
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (backup-schedule),
  `apps/web/src/ui/features/manager/BackupManager.test.tsx`.

### QA-SCHED-002 — Due schedule produces a tagged, restorable backup

- **Severity**: Critical
- **Steps**:
  1. Set the schedule time to a minute that has already passed today
     (`--time 00:00` works before midnight).
  2. Run `sh-manager server run-scheduled-backups`.
  3. Inspect the newest backup's `backup-manifest.json` and validate it:
     `sh-manager instance restore website1 <backupId>` (plan only).
- **Expected**: A new backup is created with `origin: "scheduled"`; the
  restore validation re-hashes every file and reports OK.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 5.

### QA-SCHED-003 — Double-run guard

- **Severity**: High
- **Steps**:
  1. Immediately re-run `sh-manager server run-scheduled-backups`.
- **Expected**: The instance is reported as "skipped (not due)" — the same
  daily occurrence is never taken twice, including when the web GUI's
  internal scheduler loop and a cron/systemd timer overlap.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (double-run guard),
  `apps/web/src/backup-scheduler.test.ts`.

### QA-SCHED-004 — Retention prune keeps the GFS set (clock recipe)

- **Severity**: Critical
- **Preconditions**: A throwaway instance (retention deletes directories).
- **Steps**:
  1. Set retention low: `--keep-daily 2 --keep-weekly 0 --keep-monthly 0`.
  2. Seed "aged" backups: copy an existing backup directory 3–4 times and
     edit each copy's `backup-manifest.json` → set `createdAt` to 3, 4, 5 and
     10 days ago; rename the directories to match
     (`backup-YYYYMMDD-<id>-001`); set `origin` to `"scheduled"` on the three
     newest and `"manual"` on the 10-day-old one.
  3. Run `sh-manager instance backup-prune website-tmp --dry-run`, review the
     keep/delete plan and reasons.
  4. Run `sh-manager instance backup-prune website-tmp` (apply).
- **Expected**: Dry-run deletes nothing. The apply deletes exactly the
  scheduled backups beyond the 2 newest distinct days; the newest scheduled
  backup and the manual backup are NEVER deleted, with a reason recorded per
  entry.
- **Automated equivalent**: `packages/backup/src/retention.test.ts`
  (safety invariants), `e2e/docker-e2e.test.ts` scenario 5.

### QA-SCHED-005 — Disk-low skip

- **Severity**: High
- **Steps**:
  1. On a host (or filesystem/quota) with less free space than roughly twice
     the last backup size, run `sh-manager server run-scheduled-backups`.
- **Expected**: The run skips the backup with a journaled "low disk" warning
  instead of producing a truncated/corrupt backup. Nothing is deleted.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (disk-low skip path).

### QA-SCHED-006 — Headless trigger (cron / systemd timer)

- **Severity**: Medium
- **Preconditions**: Linux host installed per [deploy/README.md](../../deploy/README.md).
- **Steps**:
  1. Install `deploy/systemd/sh-manager-scheduled-backups.{service,timer}`
     (or the crontab line) and wait for a tick.
  2. Check `systemctl list-timers` and the journal.
- **Expected**: The timer fires every 15 minutes, the one-shot runs and logs
  per-instance actions (taken / skipped / pruned), and exits 0.
- **Automated equivalent**: none (deployment glue) — covered by this manual
  case plus QA-SCHED-002/003 for the underlying behavior.

### QA-SCHED-007 — Editing the daily time reschedules correctly

- **Severity**: High
- **Steps**:
  1. Set the schedule to a minute already passed today and run
     `sh-manager server run-scheduled-backups` (a backup is taken).
  2. Change the time LATER to another minute that has ALSO passed today; run the
     trigger again (or wait for the GUI loop).
  3. Separately, change the time EARLIER than the run already taken today; run
     the trigger again.
- **Expected**: Moving the time later the same day takes a NEW backup at the new
  time — editing the policy does not reset "last run", and the new occurrence is
  not yet covered. Moving it earlier than a run already taken today does NOT
  double-run; it resumes at the new time tomorrow. The GUI "Next run" reflects
  the edit immediately. (This is the "I changed 14:35 → 14:45 but no second
  backup happened" report: later-same-day DOES run; earlier-same-day correctly
  skips.)
- **Automated equivalent**: `packages/backup/src/schedule.test.ts`
  ("rescheduling the daily time mid-day").

---

## QA-RST — Restore

### QA-RST-001 — Same-instance restore preserves identity

- **Severity**: Critical
- **Steps**:
  1. Note a CMS content marker (e.g. a form entry), then take a backup.
  2. Change/delete that content in the CMS.
  3. Run `sh-manager instance restore website1 <backupId> --apply`.
  4. Log in to the CMS again with the SAME admin credentials.
  5. Repeat the restore from the WEB console.
- **Expected**: The restore validates checksums first, restores DB + volumes,
  keeps the existing secrets (same login works), and the instance is healthy.
  The changed content is back at the backup state. The GUI restore (step 5)
  additionally takes an automatic safety backup first — it appears in the
  backup list with a `pre-restore` origin badge.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 4,
  `apps/cli/src/cli.test.ts` (restore).

### QA-RST-002 — Corrupted backup is refused before anything stops

- **Severity**: Critical (security/integrity)
- **Steps**:
  1. Copy a backup directory, flip one byte inside the copy's `database.sql`.
  2. Run `sh-manager instance restore website1 <corruptedId> --apply`.
- **Expected**: Validation fails with a checksum mismatch naming the file;
  the stack is never stopped, nothing is restored, the instance keeps running
  untouched.
- **Automated equivalent**: `apps/cli/src/cli.test.ts`
  ("restore --apply refuses a corrupted backup BEFORE the stack is touched").

### QA-RST-003 — Restore as a new instance (clone-style)

- **Severity**: High
- **Steps**:
  1. Restore a backup clone-style
     (`sh-manager instance restore <id> <backupId> --mode restore_as_clone …`
     or from the GUI) as documented in
     [backup-restore.md](../operator/backup-restore.md).
  2. Log in to the new instance.
- **Expected**: The new instance gets FRESH secrets (the old admin password
  does not work there if credentials are secret-derived; DB content matches
  the backup), and the source instance is untouched.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (restore modes).

### QA-RST-004 — Failed restore leaves the instance recoverable

- **Severity**: Critical
- **Steps**:
  1. Start a restore and interrupt it mid-DB-import (e.g. `docker stop` the
     mysql container during the import, or kill the manager process).
  2. Check `instance health`, then re-run the same restore to completion.
- **Expected**: The manifest/lock are not corrupted, no volumes were deleted,
  and a clean retry succeeds (the backup itself is untouched and stays valid;
  on the GUI path the automatic pre-restore safety backup is also available).
- **Automated equivalent**: `apps/cli/src/cli.test.ts`
  ("restore --apply that dies on the DB import leaves the instance recoverable …").

---

## QA-CLN — Clone

### QA-CLN-001 — Clone produces an isolated copy

- **Severity**: High
- **Steps**:
  1. Run `sh-manager instance clone website1 website1-staging --target-local-port 8082 --apply`.
  2. Log in to the clone with the SOURCE admin credentials.
  3. Change content in the clone; verify the source is unchanged.
- **Expected**: The clone runs as its own compose project with its own
  volumes and fresh secrets, contains the source data (source admin login
  works), and edits in one instance never appear in the other.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 6.

### QA-CLN-002 — Plan-only clone changes nothing

- **Severity**: Medium
- **Steps**:
  1. Run the same command WITHOUT `--apply`.
- **Expected**: A step-by-step plan is printed; no containers, volumes or
  directories are created.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (clone plan).

---

## QA-UPD — Update

### QA-UPD-001 — Dry-run + preflight

- **Severity**: Critical
- **Steps**:
  1. Run `sh-manager instance update website1 --dry-run`.
- **Expected**: The resolver picks the target version (respecting channel,
  compatibility, advisories and `requiresManager` gating); the preflight
  reports disk space, backup status and migration risk; nothing is changed.
- **Automated equivalent**: `packages/core/src/update.test.ts`,
  `packages/resolver/src/*.test.ts`.

### QA-UPD-002 — Execute with automatic pre-update backup

- **Severity**: Critical
- **Steps**:
  1. Run `sh-manager instance update website1` (executes when the preflight
     passes; target an available newer version, e.g. with
     `--version <x.y.z>`).
  2. After completion, list backups and check the CMS.
- **Expected**: A `pre_update` backup was taken first; the stack comes back
  on the new version; data and logins survive; health is green; the manifest
  + lock record the new version.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 2.

### QA-UPD-003 — Forced rollback recipe

- **Severity**: Critical
- **Preconditions**: Throwaway instance; local test registry (developer
  setup) so a broken target can be staged.
- **Steps**:
  1. Make the post-update health check fail (e.g. stage a target image that
     cannot become healthy, or block the frontend port).
  2. Run `sh-manager instance update <id>` against that target.
- **Expected**: The update detects the failed health check, rolls back to the
  previous version, clears maintenance mode, and reports `rolledBack: true`.
  The CMS works on the old version afterwards.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 7.

### QA-UPD-004 — CMS-requested update drained by the manager

- **Severity**: High
- **Steps**:
  1. As CMS admin, request the update from the CMS admin UI (System →
     Updates).
  2. Watch the manager console (or run
     `sh-manager instance process-operations website1`).
- **Expected**: The CMS parks the request; the manager claims and executes
  it; the terminal status (`succeeded`) propagates back to the CMS admin UI
  including the manager's last-seen timestamp.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 3.

---

## QA-ADDR — Address changes

### QA-ADDR-001 — Local port change

- **Severity**: High
- **Steps**:
  1. Run `sh-manager instance set-address website1 --port 8085`.
  2. Open the new URL; check the old port.
- **Expected**: Config regenerated, stack restarted, CMS reachable on 8085
  and gone from the old port. Logins still work (secrets untouched).
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (set-address).

### QA-ADDR-002 — Production domain change routes through Traefik

- **Severity**: High
- **Preconditions**: Production-mode server with a DNS record you control.
- **Steps**:
  1. Run `sh-manager instance set-address website1 --domain new.example.org`.
  2. Open `https://new.example.org` after DNS/TLS propagation.
- **Expected**: Traefik routes the new domain with a valid certificate; the
  old domain stops serving the instance.
- **Automated equivalent**: `packages/traefik/src/*.test.ts` (config
  generation; the real ACME/DNS leg is manual-only).

---

## QA-MAIL — Outbound mail

### QA-MAIL-001 — Set a real SMTP DSN

- **Severity**: High
- **Steps**:
  1. Run `sh-manager instance mailer website1 --set "smtp://USER:PASS@mail.example.org:587"`.
  2. Run `sh-manager instance mailer website1` (no flags = show).
  3. Trigger a CMS e-mail (e.g. password reset) to a test mailbox.
- **Expected**: The DSN is stored in the instance's `secrets.env`
  (mode 0600); every CLI/GUI display shows it REDACTED (credentials masked);
  the stack restarts and the test mail arrives via the configured relay.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (set/get-mailer),
  `packages/instances/src/secrets.test.ts` (mailer DSN + redaction).

### QA-MAIL-002 — Clear falls back to bundled Mailpit

- **Severity**: Medium
- **Steps**:
  1. Run `sh-manager instance mailer website1 --clear`.
  2. Trigger a CMS e-mail; open the Mailpit UI (local mode).
- **Expected**: The override is removed; mail flows to the bundled Mailpit
  again; the GUI shows "default (Mailpit)".
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (`--clear`).

### QA-MAIL-003 — Invalid DSN refused without side effects

- **Severity**: Medium
- **Steps**:
  1. Run `sh-manager instance mailer website1 --set "not-a-dsn"`.
- **Expected**: Validation rejects the DSN (scheme required); secrets file is
  untouched; no restart happens.
- **Automated equivalent**: `apps/cli/src/cli.test.ts`
  ("set-mailer refuses a schemeless DSN …").

---

## QA-PLUG — In-CMS plugin operations (managed mode)

The manager puts instances in `managed` plugin install mode: the CMS verifies
and parks plugin operations; the manager runs the composer step and finalizes.

### QA-PLUG-001 — Install mode + trust chain are wired

- **Severity**: Critical (security)
- **Steps**:
  1. In the CMS admin UI open Admin → Plugins; check the displayed install
     mode.
  2. On the host: `docker compose exec backend printenv | grep SELFHELP_PLUGIN`
     (from the instance directory; do not paste values into results).
- **Expected**: Install mode is `managed`. `SELFHELP_PLUGIN_REQUIRE_SIGNATURE`
  is `true` and `SELFHELP_PLUGIN_TRUSTED_KEYS` carries exactly the manager's
  active trusted keys.
- **Automated equivalent**: `packages/docker/src/env.test.ts` (plugin trust
  env), `e2e/docker-e2e.test.ts` scenario 9.

### QA-PLUG-002 — Unsigned plugin install is refused (fail closed)

- **Severity**: Critical (security)
- **Steps**:
  1. In the CMS plugin install dialog, paste a syntactically valid plugin
     manifest WITHOUT any signature data and submit.
- **Expected**: The request is rejected at submission with a signature error;
  no operation is parked; the manager console shows nothing to drain.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 9 (unsigned
  refusal), backend suite.

### QA-PLUG-003 — Signed plugin install drained end to end

- **Severity**: High
- **Preconditions**: A reachable plugin registry entry signed by a trusted
  key (e.g. the official registry's demo plugin, or a dev-signed entry on a
  test registry).
- **Steps**:
  1. Install the plugin from the CMS plugin catalogue.
  2. Watch the manager drain the parked operation (console or
     `instance process-operations`).
  3. After success: recreate the containers
     (`sh-manager instance set-address …` or a manual
     `docker compose up -d --force-recreate`) and re-check the plugin.
  4. Run a core update (QA-UPD-002) and re-check the plugin.
- **Expected**: The operation goes parked → drained → succeeded; the plugin
  is active in the CMS; it SURVIVES a container recreate and a core update
  (the manager restores/reinstalls the composer state automatically).
- **Automated equivalent**: `packages/core/src/plugin-state.test.ts`,
  `apps/cli/src/plugin-state-client.test.ts` (success paths);
  `e2e/docker-e2e.test.ts` scenario 9 (pipeline + failure propagation).

### QA-PLUG-004 — Failed plugin operation reaches a terminal state

- **Severity**: High
- **Steps**:
  1. Request a plugin whose composer package cannot resolve (a signed entry
     pointing at a nonexistent package — see scenario 9 of the e2e for the
     recipe).
  2. Let the manager drain it.
- **Expected**: The drain reports the composer failure; the CMS operation
  moves out of "running" to a terminal cancelled/failed state with the error
  visible; the instance stays healthy; the poller does not retry it forever.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 9.

---

## QA-SAFE — Safe mode

### QA-SAFE-001 — Enter and leave safe mode

- **Severity**: High
- **Steps**:
  1. Run `sh-manager instance safe-mode enable website1` (see
     [safe-mode-and-recovery.md](../operator/safe-mode-and-recovery.md)).
  2. Check the CMS: plugins must be inactive, core must work.
  3. Run `sh-manager instance safe-mode disable website1`.
- **Expected**: Safe mode boots the backend with core bundles only; leaving
  it restores plugin state. Both transitions keep the instance healthy.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (safe-mode).

### QA-SAFE-002 — Safe mode as recovery from a broken plugin

- **Severity**: Medium
- **Steps**:
  1. With a deliberately broken plugin state (e.g. after QA-PLUG-004),
     enter safe mode, uninstall the offending plugin from the CMS, leave safe
     mode.
- **Expected**: The instance recovers to healthy without a restore.
- **Automated equivalent**: none (recovery judgment) — underlying commands
  covered above.

---

## QA-SUP — Support bundle

### QA-SUP-001 — Bundle is complete

- **Severity**: Medium
- **Steps**:
  1. Run `sh-manager instance support-bundle website1`.
  2. Inspect the produced directory.
- **Expected**: It contains the manifest, lock, compose config, recent logs,
  health snapshot and journal excerpts — enough to diagnose remotely.
- **Automated equivalent**: `packages/support/src/*.test.ts`.

### QA-SUP-002 — Bundle never leaks secrets

- **Severity**: Critical (security)
- **Steps**:
  1. Search the bundle for the instance's known secret values:
     `grep -r "<a-secret-substring>" <bundle-dir>` (use the local
     `secrets.env` values; do NOT record them).
- **Expected**: Zero hits. DSNs, passwords, tokens and keys are redacted
  everywhere, including inside logs.
- **Automated equivalent**: `packages/support/src/*.test.ts` (redaction).

---

## QA-GUI — Web console

### QA-GUI-001 — Login, session, logout

- **Severity**: Critical
- **Steps**:
  1. Log in with the operator account; reload the page; log out; try a
     console URL again.
- **Expected**: Session survives the reload; after logout every console route
  redirects to login; API calls without a session return 401.
- **Automated equivalent**: `apps/web/src/server.test.ts` (auth),
  `apps/web/src/ui/App.test.tsx` (login flow).

### QA-GUI-002 — Wrong credentials and lockout behavior

- **Severity**: High
- **Steps**:
  1. Attempt several logins with a wrong password.
- **Expected**: Clear failure message, no user enumeration, no session
  issued. (If rate limiting is configured, it engages.)
- **Automated equivalent**: `packages/auth/src/*.test.ts` (failure paths).

### QA-GUI-003 — Operations console reflects reality

- **Severity**: High
- **Steps**:
  1. Start a long operation (update or restore) from the GUI.
  2. Watch the journal stream; try to start a second conflicting operation on
     the same instance.
- **Expected**: Progress streams live; the per-instance lock makes the second
  operation queue or refuse with a clear message — never two writers on one
  instance (this includes the backup scheduler loop and the CMS plugin/update
  drain).
- **Automated equivalent**: `apps/web/src/jobs.test.ts` (locking),
  `apps/web/src/backup-scheduler.test.ts` (scheduler vs drain),
  `apps/web/src/ui/features/manager/OperationsConsole.test.tsx`.

### QA-GUI-004 — CSRF on state-changing requests

- **Severity**: Critical (security)
- **Steps**:
  1. From the browser dev tools, replay a state-changing API call (e.g.
     backup) WITHOUT the CSRF token header.
- **Expected**: The BFF rejects it; with the token it succeeds.
- **Automated equivalent**: `apps/web/src/server.test.ts` (CSRF).

### QA-GUI-005 — Secrets never rendered

- **Severity**: Critical (security)
- **Steps**:
  1. Walk the console: instance detail, mailer dialog, backup views,
     operation logs after an install.
- **Expected**: No password, DSN credential, token or key material is ever
  visible; the one exception is the install-time admin password shown ONCE.
  Mailer DSNs appear redacted.
- **Automated equivalent**: `apps/web/src/instance-validation.ts` tests +
  `redactSecrets` coverage in `apps/web/src/*.test.ts`.

---

## QA-WRAP — Wrapper lifecycle verbs

Preconditions: wrapper script generated per
[install.md](../operator/install.md) /
[windows-quickstart.md](../operator/windows-quickstart.md)
(`docker run --rm <image> wrapper --shell bash > shm.sh` or
`--shell powershell > shm.ps1`).

### QA-WRAP-001 — `up` / `down`

- **Severity**: High
- **Steps**:
  1. Run `./shm.sh up`; open `http://127.0.0.1:8765`.
  2. Run `./shm.sh down`.
- **Expected**: `up` starts the GUI container in the background and prints
  the URL; `down` stops + removes ONLY the manager container — instances keep
  running untouched.
- **Automated equivalent**: `apps/cli/src/wrapper.test.ts`.

### QA-WRAP-002 — `update` (self-update)

- **Severity**: High
- **Steps**:
  1. Run `./shm.sh update`.
- **Expected**: The manager pulls its new image and restarts the GUI on it;
  afterwards the console shows the new version and reconnects to all existing
  instances automatically.
- **Automated equivalent**: `apps/cli/src/self-update.test.ts`.

### QA-WRAP-003 — `reinstall` reconnects to existing instances

- **Severity**: High
- **Steps**:
  1. Run `./shm.sh reinstall`.
  2. Open the console and check the instance list + health.
- **Expected**: Fresh image, same state folder: every instance is still
  listed, healthy, and operable — no data or registration is lost.
- **Automated equivalent**: `apps/cli/src/wrapper.test.ts` (verbs), state
  reconnection via `apps/cli/src/cli.test.ts` (inventory reads).

---

## QA-RMV — Remove modes **[destructive]**

### QA-RMV-001 — Disable keeps everything

- **Severity**: High
- **Steps**:
  1. Run `sh-manager instance remove website2 --mode disable`.
- **Expected**: Containers stop; volumes, directory, backups and inventory
  entry remain; another instance is unaffected. The instance can be brought
  back up.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 10.

### QA-RMV-002 — Remove containers, keep data

- **Severity**: High
- **Steps**:
  1. Run `sh-manager instance remove website2 --mode remove_containers_keep_data`.
- **Expected**: Containers gone, volumes + directory + backups retained — a
  later reinstall/restore can resurrect the instance.
- **Automated equivalent**: `apps/cli/src/cli.test.ts` (remove modes).

### QA-RMV-003 — Full delete demands typed confirmation

- **Severity**: Critical
- **Steps**:
  1. Run `sh-manager instance remove website2 --mode full_delete` WITHOUT
     `--confirm` (expect refusal), then with the wrong text (refusal), then
     with `--confirm "delete website2" --delete-volumes`.
- **Expected**: Only the exact confirmation executes. Volumes and the
  directory are removed; other instances stay healthy. `docker volume ls`
  shows no leftovers for the removed instance.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 10,
  `apps/cli/src/cli.test.ts` (confirmation gate).

---

## QA-PURGE — Server purge **[destructive]**

### QA-PURGE-001 — Purge removes everything but backups

- **Severity**: Critical
- **Steps**:
  1. Run `sh-manager server purge` WITHOUT confirmation (expect refusal).
  2. Run `sh-manager server purge --confirm "purge selfhelp"`.
  3. Check `docker ps -a`, `docker volume ls`, the install root, and the
     per-instance `backups/` folders.
- **Expected**: Every instance (containers + volumes + dirs), the proxy and
  the server/manager state are gone; per-instance backups and the audit log
  are KEPT; the typed confirmation is the only path in.
- **Automated equivalent**: `e2e/docker-e2e.test.ts` scenario 11,
  `apps/cli/src/cli.test.ts` (purge).

### QA-PURGE-002 — Re-bootstrap after purge

- **Severity**: High
- **Steps**:
  1. Run `sh-manager server init --server-id qa-reborn --mode local`.
  2. Open the web console.
- **Expected**: Init succeeds immediately (retained backup folders do NOT
  count as a foreign install); the console shows the first-run operator setup
  again (manager state was reset).
- **Automated equivalent**: `apps/cli/src/cli.test.ts`
  (purge + re-bootstrap regression), `e2e/docker-e2e.test.ts` scenario 11.

---

## Appendix A — Linux setup

Follow [install.md](../operator/install.md). Summary for a QA host:

1. Docker Engine 24+ with Compose v2 (`docker compose version`).
2. A dedicated install root, e.g. `/opt/selfhelp-qa` (delete it after the
   run; QA-PURGE leaves only backups).
3. Generate the wrapper: `docker run --rm ghcr.io/humdek-unibe-ch/sh-manager:latest wrapper --shell bash > shm.sh && chmod +x shm.sh` (save it inside the install root).
4. Local mode is sufficient for everything except QA-ADDR-002 (needs a
   production-mode server with real DNS).
5. For QA-SCHED-006 install the systemd units from [deploy/](../../deploy/README.md).

Platform notes:

- File permissions: verify `secrets.env` files are mode `0600` (QA-MAIL-001).
- Use a non-root user in the `docker` group to mirror production operation.

## Appendix B — Windows Docker Desktop setup

Follow [windows-quickstart.md](../operator/windows-quickstart.md). Summary:

1. Docker Desktop with the WSL2 backend; ensure it is running before any
   command.
2. PowerShell wrapper: `docker run --rm ghcr.io/humdek-unibe-ch/sh-manager:latest wrapper --shell powershell > shm.ps1` (saved into the state folder, e.g. `C:\selfhelp-qa`).
3. Run every CLI case through `.\shm.ps1 <args>`.

Platform notes:

- Path translation: instance paths shown by the CLI are engine-side paths;
  find the state under the chosen state folder (see
  [local-windows-walkthrough.md](../operator/local-windows-walkthrough.md)).
- Windows has no systemd/cron: QA-SCHED-006 is replaced by Task Scheduler
  running `.\shm.ps1 server run-scheduled-backups` every 15 minutes, OR by
  relying on the web GUI's built-in scheduler loop (keep `.\shm.ps1 up`
  running and verify QA-SCHED-002 happens automatically at the scheduled
  time).
- The `0600` permission check (Appendix A) does not apply to NTFS; instead
  verify the state folder is not inside a synced/shared directory.
