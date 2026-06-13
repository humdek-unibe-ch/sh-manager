# Scheduled backups and retention

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `1.4.0+`)
Last verified: 2026-06-13
Source of truth: `packages/backup/src/schedule.ts`, `packages/backup/src/retention.ts`, `apps/cli/src/actions.ts`, `apps/web/src/backup-scheduler.ts`

The manager can take a **nightly backup of every instance automatically** and
keep the backup set bounded with a **GFS (grandfather-father-son) retention
policy** — recent dailies, weekly Mondays, monthly 1st-of-month backups, and a
hard maximum age. Each instance has its own schedule, stored in the instance
manifest and editable from the CLI or the web console's Backups panel.

## How it runs

Two triggers drive the same per-instance logic; you can use either or both —
a built-in guard prevents double runs:

1. **The web console process** (when it is running) ticks an internal
   scheduler loop and takes due backups automatically. Disable with the env
   var `SHM_BACKUP_SCHEDULER=0`.
2. **A one-shot command** for headless servers (cron / systemd timer):

```bash
sh-manager server run-scheduled-backups
```

Both paths are journaled and audited, run under the per-instance operation
lock (never concurrently with an update, restore, or CMS plugin drain on the
same instance), and record the last run in
`<root>/manager/backup-scheduler.json` so the same daily occurrence is never
taken twice — even when the GUI loop and a cron job overlap.

Times are interpreted in the **manager server's local time zone**. Catch-up is
bounded: if the manager was down past the scheduled time (even for a week), it
takes exactly **one** backup on the next opportunity — never a storm.

## Enable a schedule

CLI:

```bash
# defaults: time 02:00, keep 7 dailies / 5 weeklies / 12 monthlies, max age 365 days
sh-manager instance backup-schedule website1 --enable

# everything explicit:
sh-manager instance backup-schedule website1 \
  --enable --time 02:30 \
  --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --max-age-days 365

# show the current schedule, last/next run and disk footprint:
sh-manager instance backup-schedule website1

# turn it off (existing backups stay):
sh-manager instance backup-schedule website1 --disable
```

Web console: open the instance's **Backups** panel — the schedule card shows
the same policy with the last/next run, per-backup origin badges, the current
total size, and the projected steady-state footprint.

## The retention model

Only **scheduled** backups compete for GFS slots. The other origins are
protected:

| Origin | Pruned? |
| --- | --- |
| `manual` (CLI/GUI backup) | **Never** pruned automatically |
| `pre_update` / `pre_restore` (safety backups) | Only when older than `--max-age-days` |
| `scheduled` (nightly) | By the GFS slots below |

GFS slots (computed on local calendar days):

- **daily** — every scheduled backup from the most recent N distinct days.
- **weekly** — the newest backup of each of the most recent N **Mondays**.
- **monthly** — the newest backup of each of the most recent N **1st-of-month**
  days (a Monday-the-1st backup serves both roles; monthly wins for display).
- **max age** — a hard cap: prunable backups older than this are deleted even
  if they would fill a slot.

Hard safety invariants (these hold no matter what the policy says):

- The **newest scheduled backup is never deleted** — an instance with a working
  schedule always keeps its latest safety point.
- Manual backups are never deleted.
- Pruning only ever touches direct children of the instance's `backups/`
  directory whose names match this instance's backup-id pattern
  (`backup-YYYYMMDD-<instanceId>-NNN`); foreign or corrupt directories are
  reported and left alone.

Preview and apply retention manually at any time:

```bash
sh-manager instance backup-prune website1 --dry-run   # plan only, deletes nothing
sh-manager instance backup-prune website1             # apply the plan
```

Every keep/prune decision carries an explicit reason (`daily`, `weekly`,
`monthly`, `newest-scheduled`, `manual`, `safety-within-max-age`,
`beyond-retention`, `older-than-max-age`) so the plan is auditable.

## Size planning

The schedule status (CLI and GUI) projects disk usage:

- **Steady state** ≈ (daily + weekly + monthly slots) × average recent backup
  size. With the defaults (7+5+12 = 24 slots) and, say, 500 MB per backup,
  plan for roughly 12 GB per instance plus headroom.
- **Required free** before each run ≈ 2× the newest backup size (minimum
  512 MiB when there is no size history yet). When free disk on the backups
  filesystem is below this, the scheduled run **skips the backup with a
  journaled warning** (`skipped_low_disk`) instead of writing a truncated
  backup. Manual `instance backup` is not blocked by this check.

## Headless servers (cron / systemd)

When the web console is not running permanently, trigger the one-shot from the
host scheduler. Ready-made examples live in [deploy/](../../deploy/README.md):

- systemd: `deploy/systemd/sh-manager-scheduled-backups.service` +
  `…-scheduled-backups.timer` (every 15 minutes, `Persistent=true` for
  catch-up after downtime).
- cron: `deploy/cron/sh-manager-scheduled-backups.crontab.example`
  (`*/15 * * * *`).

The 15-minute cadence is intentional: the command itself decides per instance
whether anything is due, so frequent ticks cost nothing and keep the backup
close to the configured time.

## Verify it works

1. Set a due-now schedule (a time already passed today):

```bash
sh-manager instance backup-schedule website1 --enable --time 00:00
sh-manager server run-scheduled-backups
```

2. Expect the run to report `backup_taken` plus a prune summary. The new
   backup directory's `backup-manifest.json` carries `"origin": "scheduled"`.
3. Validate it is restorable (validation re-hashes every file):

```bash
sh-manager instance restore website1 <backupId>   # plan only
```

4. Run the one-shot again: the instance reports `skipped_not_due` (double-run
   guard).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Run reports `skipped_not_due` | Already ran for today's occurrence (see `lastRunAt` in the schedule status). Expected after a successful run. |
| Run reports `skipped_low_disk` | Free space below 2× the newest backup. Free disk or prune (`instance backup-prune`), then re-run. |
| Run reports `skipped_not_active` | The instance is disabled/removed. Re-enable it or disable its schedule. |
| Run reports `failed` | The backup itself failed; the detail names the step. The journal + `instance health` show more. Nothing was pruned for that instance in the failed run. |
| Nothing runs automatically | Is the web console process up (or a cron/systemd trigger installed)? Is `SHM_BACKUP_SCHEDULER` unset/`1`? Is the schedule `enabled`? |
| A backup you expected to keep was pruned | Check the dry-run plan reasons; only `scheduled` backups beyond the slot set or past max age are pruned. Manual backups are never touched — take a manual backup (or copy a scheduled one) to pin a state forever. |
| Backups grow beyond the projection | Instance data grew; the projection follows recent sizes. Lower the slot counts or move old manual backups elsewhere. |

## Related

- [Backup & restore](backup-restore.md) — manual backups, validation, restore
  modes.
- [Deploy triggers](../../deploy/README.md) — systemd/cron wiring.
- [Manual QA plan](../qa/manual-test-plan.md) — QA-SCHED suite.
