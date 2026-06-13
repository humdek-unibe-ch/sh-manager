# Back up and restore an instance

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `1.4.0+`)
Last verified: 2026-06-13
Source of truth: `apps/cli/src/bin.ts`, `packages/backup/src`

Backups are **checksummed** and cover every required area. Restores are
**validated** against the backup's integrity manifest before anything is written,
and the **secret policy** is explicit (same-instance restores keep secrets;
clone-style restores get fresh secrets).

Both actions are also available in the persistent web UI, where a restore
always takes an automatic pre-restore backup first — see
[GUI instance management](gui-instance-management.md). For **automatic nightly
backups with GFS retention**, see
[Scheduled backups and retention](scheduled-backups.md).

## Create a backup

```bash
sh-manager instance backup website1
# Backup backup-20260608-website1-001 -> /opt/selfhelp/instances/website1/backups/backup-20260608-website1-001
# Areas: database, uploads, plugin-artifacts, secrets, config  Files: N
```

Several backups on the same day get distinct sequence numbers automatically
(`…-001`, `…-002`, …); pass `--seq <n>` only to force a specific one.

Each backup writes a manifest with per-file SHA-256 checksums, the list of
included areas, and its **origin** — `manual` (CLI/GUI), `scheduled` (nightly
run), `pre_update`, or `pre_restore` (automatic safety backups). The origin is
shown as a badge in the web console and controls automatic retention:
**manual backups are never pruned automatically**
(see [scheduled-backups.md](scheduled-backups.md)).

Take a backup before every risky operation. Updates already take one
automatically (see [update](update.md)).

## Inspect / validate a restore (no changes)

Restore is a two-phase command: by default it **validates** the backup and prints
the **plan**; nothing is materialised until you pass `--apply`.

```bash
sh-manager instance restore website1 backup-20260608-website1-001
```

If validation fails (checksum mismatch, missing area, unknown backup id) the
command prints the errors and exits non-zero — no changes are made.

## Apply a restore

### Same instance (default)

Restores in place. Existing secrets are **preserved**:

```bash
sh-manager instance restore website1 backup-20260608-website1-001 --apply
# "Same-instance restore: existing secrets preserved in place."
```

### Restore as a clone

Restore a backup into a **different** instance identity, with **fresh** secrets
that share nothing with the source:

```bash
sh-manager instance restore website1 backup-20260608-website1-001 \
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

- [Scheduled backups](scheduled-backups.md) — automatic nightly backups + GFS retention.
- [Clone & remove](clone-remove.md) — copy a live instance (not from a backup).
- [Update](update.md) — updates back up automatically and roll back on failure.
