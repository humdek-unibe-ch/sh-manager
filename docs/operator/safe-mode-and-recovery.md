# Safe mode and recovery

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`)
Last verified: 2026-06-08
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

## Recovery playbook

1. **Stabilise**: if a plugin is suspected, `safe-mode enable` the instance.
2. **Diagnose**: run `doctor` and `instance health`; collect a support bundle if
   you need help.
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
