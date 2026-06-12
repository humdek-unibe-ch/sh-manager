# Back up and restore an instance

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`)
Last verified: 2026-06-12
Source of truth: `apps/cli/src/bin.ts`, `packages/backup/src`

Backups are **checksummed** and cover every required area. Restores are
**validated** against the backup's integrity manifest before anything is written,
and the **secret policy** is explicit (same-instance restores keep secrets;
clone-style restores get fresh secrets).

Both actions are also available in the persistent web UI, where a restore
always takes an automatic pre-restore backup first — see
[GUI instance management](gui-instance-management.md).

## Create a backup

```bash
sh-manager instance backup website1
# Backup 2026-06-08-1 -> /opt/selfhelp/instances/website1/backups/2026-06-08-1
# Areas: database, uploads, plugin-artifacts, secrets, config  Files: N
```

Add a sequence number when taking several on the same day:

```bash
sh-manager instance backup website1 --seq 2
```

Each backup writes a manifest with per-file SHA-256 checksums and the list of
included areas, so a later restore can prove integrity.

Take a backup before every risky operation. Updates already take one
automatically (see [update](update.md)).

## Inspect / validate a restore (no changes)

Restore is a two-phase command: by default it **validates** the backup and prints
the **plan**; nothing is materialised until you pass `--apply`.

```bash
sh-manager instance restore website1 2026-06-08-1
```

If validation fails (checksum mismatch, missing area, unknown backup id) the
command prints the errors and exits non-zero — no changes are made.

## Apply a restore

### Same instance (default)

Restores in place. Existing secrets are **preserved**:

```bash
sh-manager instance restore website1 2026-06-08-1 --apply
# "Same-instance restore: existing secrets preserved in place."
```

### Restore as a clone

Restore a backup into a **different** instance identity, with **fresh** secrets
that share nothing with the source:

```bash
sh-manager instance restore website1 2026-06-08-1 \
  --mode restore_as_clone --new-domain website1-copy.example.ch --apply
# "Fresh secrets written: N files (source secrets never reused)."
```

### Disaster recovery (importing another instance's backup)

Importing a backup that came from a **different** instance is blocked unless you
explicitly acknowledge it:

```bash
sh-manager instance restore website1 <backupId> --disaster-recovery-import --apply
```

## Restore modes at a glance

| Mode | Identity | Secrets |
| --- | --- | --- |
| `same_instance` (default) | Same instance | Preserved in place |
| `restore_as_clone` | New identity (`--new-domain`) | Regenerated (fresh) |

## Verify

```bash
sh-manager instance health website1
```

## Related

- [Clone & remove](clone-remove.md) — copy a live instance (not from a backup).
- [Update](update.md) — updates back up automatically and roll back on failure.
