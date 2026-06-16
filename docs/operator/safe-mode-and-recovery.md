# Safe mode and recovery

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`; `instance plugin-recover` needs `1.5.8+`)
Last verified: 2026-06-16
Source of truth: `apps/cli/src/bin.ts`, `apps/cli/src/actions.ts`, `packages/core/src`

When a plugin or a change breaks an instance, **plugin safe-mode** boots the CMS
with core bundles only so you can get back in and fix it.

## Toggle plugin safe-mode

```bash
# boot the instance with plugins disabled
sh-manager instance safe-mode enable website1

# return to normal once the instance is healthy again
sh-manager instance safe-mode disable website1
```

Safe-mode is instance-scoped and reversible. It does not delete anything — it
flips the instance into a plugins-off boot so a bad plugin cannot keep it down.

## Diagnose

```bash
# host-level resource preflight (disk, memory, CPU, ports, Docker/Compose)
sh-manager doctor

# instance health (backend + frontend probes)
sh-manager instance health website1
```

For a deeper, shareable snapshot, collect a [support bundle](support-bundle.md).

## Repair a broken instance (missing manifest)

If `instance list` shows an instance as `broken` (or commands fail with
"Instance \<id\> not found in this state root"), the instance's manifest is
missing or unreadable while other state still exists:

```bash
sh-manager instance repair website1
```

Repair reconstructs the manifest from the **newest backup snapshot**, or — when
no backup exists — from the inventory, lock file, and compose file, and
re-registers the instance in the inventory if it dropped out. It is a no-op on
a healthy instance and refuses fully deleted ones. It also backfills the
per-instance manager token used for CMS-requested updates.

## Recover a backend that crash-loops after a half-removed plugin

Symptom: the backend logs `Uncaught Error: Class "…\…Bundle" not found` on a
loop and every request 500s. This happens when a plugin uninstall was
**interrupted** (often: a `self-update` ran at the same time and recreated
containers mid-drain). The plugin's package was removed, but the generated bundle
registration still names it — so the Symfony kernel cannot boot, and `bin/console`
itself fatals (you cannot fix it with a normal console command).

```bash
sh-manager instance plugin-recover website1
```

What it does:

1. **Forces safe mode** so the kernel boots with core bundles only. Because the
   kernel is dead, it creates the safe-mode marker **directly** (no `bin/console`).
2. **Restarts** the backend (now boots, plugins off — the crash loop stops).
3. **Finalizes the parked uninstall** (`run-operation` removes the plugin row and
   regenerates the bundle registration) and **reconciles** it from the database
   (`selfhelp:plugin:repair`).
4. **Leaves safe mode and probes a real boot.** If it boots cleanly, recovery is
   complete (plugins on). If it still fatals, safe mode is **re-enabled** so the
   instance stays UP, and you are told to re-trigger the uninstall from the CMS
   admin (reachable now) and run the command again, or restore a backup.

Use `--keep-safe-mode` to stop after the repair (inspect before re-enabling
plugins). When fully fixed, `sh-manager instance safe-mode disable website1`.

> Prevention: since `1.5.8` `sh-manager self-update` refuses to run while an
> instance operation (install/update/backup/**plugin drain**) is in progress, so
> an update can no longer interrupt a plugin uninstall. Let operations finish, or
> override with `self-update --force` only when the operation journal is stale.

## Recovery playbook

1. **Stabilise**: if a plugin is suspected, `safe-mode enable` the instance. If
   the backend crash-loops with `Class "…Bundle" not found` (a half-removed
   plugin), run `instance plugin-recover <id>` (above).
2. **Diagnose**: run `doctor` and `instance health`; if state files are damaged,
   run `instance repair`; collect a support bundle if you need help.
3. **Roll back a bad update**: failed updates roll back automatically. If a change
   you applied manually broke things, restore the pre-change backup:
   `sh-manager instance restore <id> <backupId> --apply` (see
   [backup & restore](backup-restore.md)).
4. **Recover the containers**: if only the containers are gone but data is intact,
   reinstall/clone with the pinned versions from the instance lock file.
5. **Return to normal**: once healthy, `safe-mode disable` and re-verify with
   `instance health`.

## What recovery never does

- It never deletes the database, uploads, plugin artifacts, secrets, or backups.
- It never runs `docker compose down -v`.
- Data is only ever removed by an explicit, confirmed `full_delete`
  (see [clone & remove](clone-remove.md)).
