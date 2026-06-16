# Clone and remove an instance

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`)
Last verified: 2026-06-12
Source of truth: `apps/cli/src/bin.ts`, `packages/instances/src/remove.ts`, `packages/backup/src/clone.ts`

Both actions are also available in the persistent web UI with the same modes
and typed confirmations — see
[GUI instance management](gui-instance-management.md).

## Clone an instance

Cloning produces an **isolated** copy with **fresh secrets** — the clone never
shares database passwords, app keys, or any secret with the source.

The target address follows the **source's mode**: a production source is
cloned onto a new `--domain`, a local (port-published) source onto a new
`--target-local-port`.

Preview the clone plan (no changes):

```bash
# production source → new domain
sh-manager instance clone website1 website1-staging --domain staging.example.ch

# local source → new localhost port
sh-manager instance clone localtest localtest-copy --target-local-port 9124
```

Apply it (writes fresh, isolated secrets for the target):

```bash
sh-manager instance clone website1 website1-staging \
  --domain staging.example.ch --apply
# "Fresh secrets written for website1-staging: N files (source never copied)."
```

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--domain <domain>` | required for production sources | New domain for the clone. |
| `--target-local-port <port>` | required for local sources | New `127.0.0.1` port for the clone. |
| `--no-preserve-versions` | preserve | Resolve latest compatible versions instead of pinning the source lock. |
| `--no-uploads` | copy | Do not copy uploads. |
| `--no-plugins` | copy | Do not copy plugin artifacts. |
| `--apply` | off | Materialise the target on disk (otherwise plan-only). |

By default the clone **pins the source's versions** (via its lock file) so the
copy is byte-identical in version terms; use `--no-preserve-versions` to move the
clone onto the latest compatible releases.

## Remove an instance

`remove` has three modes, from safe to destructive. Only `full_delete` can touch
data, and only when you type the confirmation.

### Disable (reversible)

Stops serving but keeps everything. Marks the inventory entry disabled:

```bash
sh-manager instance remove website1 --mode disable
```

> In the web console this is the dedicated **Disable / Enable** toggle button on
> the instance, not a Remove option — see
> [GUI instance management](gui-instance-management.md).

### Enable (bring a stopped instance back)

The inverse of `disable` (and of `remove_containers_keep_data`): starts the
containers again (`docker compose up -d` — starting the stopped ones or
recreating the kept-data ones), remounts composer-installed plugins, health-probes
the instance, and marks the inventory entry `active` again. All data is preserved,
so it comes back exactly as it was:

```bash
sh-manager instance enable website1
```

In the web console this is the **Enable** button that appears on a disabled
instance. Enabling refuses an instance that is already active, mid-operation
(`installing`/`updating`), or in an `error` state.

### Remove containers, keep data (reversible)

Removes the containers but keeps all persistent data (volumes, secrets, backups):

```bash
sh-manager instance remove website1 --mode remove_containers_keep_data
```

### Full delete (destructive, confirmed)

Removes the instance. By default it still **keeps** volumes and backups; deleting
them is opt-in and requires a typed confirmation:

```bash
# remove the instance but keep volumes + backups
sh-manager instance remove website1 --mode full_delete --confirm "delete website1"

# also delete persistent volumes and/or backups (irreversible)
sh-manager instance remove website1 --mode full_delete \
  --delete-volumes --delete-backups --confirm "delete website1"
```

The confirmation text must be exactly `delete <id>`. Without it, a full delete is
blocked and the command exits non-zero.

> The manager never runs `docker compose down -v` and never deletes MySQL volumes
> implicitly. Data loss only happens through an explicit `--delete-volumes` on a
> confirmed `full_delete`.

## Mode summary

| Mode | Containers | Data (volumes/secrets/backups) | Reversible |
| --- | --- | --- | --- |
| `disable` | kept (stopped) | kept | yes — `sh-manager instance enable <id>` |
| `remove_containers_keep_data` | removed | kept | yes — `sh-manager instance enable <id>` |
| `full_delete` | removed | kept unless `--delete-volumes` / `--delete-backups` | only if data kept |
