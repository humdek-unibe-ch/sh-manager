# Update an instance

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`)
Last verified: 2026-06-12
Source of truth: `apps/cli/src/bin.ts`, `apps/cli/src/actions.ts`, `packages/core/src/update.ts`

Updates are **backup-first** and **rollback-on-failure**. The manager resolves a
compatible target version (honouring security advisories and core ⇄ frontend ⇄
plugin compatibility), runs a preflight, and only then applies the change.

## 1. Preview the update (dry run)

Always start with a dry run. It shows the resolved plan and the preflight; it
changes nothing.

```bash
sh-manager instance update website1 --dry-run
```

Optionally target a specific channel/version:

```bash
sh-manager instance update website1 --dry-run --channel stable --version latest
```

Read the preflight output:

- **ok** — safe to apply.
- **warning** — apply with care; read the reasons.
- **blocked** — do not apply; the reasons explain what to fix first (for example
  an incompatible plugin or an open advisory).

## 2. Apply the update

```bash
sh-manager instance update website1
```

The execution is reported step by step. The manager:

1. Takes a fresh **backup** first.
2. Pulls the signed target images and re-pins digests in `lock.json`.
3. Runs migrations.
4. Health-checks.
5. On any failure, **rolls back** to the pre-update state and reports
   `ROLLED BACK`.

### Destructive migrations

If the target carries a migration flagged as destructive, the update is blocked
until you explicitly accept the risk:

```bash
sh-manager instance update website1 --accept-migration-risk
```

Take a manual backup and read the release notes before using this flag.

## 3. Verify

```bash
sh-manager instance health website1
```

## CMS-requested updates (instance-scoped)

The CMS never controls Docker. When an instance requests an update from its admin
UI, it records an **instance-scoped** operation; the manager claims and executes
it. The wiring is automatic:

- The per-instance `SELFHELP_MANAGER_TOKEN` is **generated at install** and
  injected into the instance's backend via its secrets env. Existing instances
  get it backfilled by the next `sh-manager instance update` or
  `sh-manager instance repair <id>`.
- The default transport **execs into the backend container** (no published
  port, no URL to configure); the container's own token authenticates the call.
- While the **persistent web UI** is running, a background poller drains
  pending operations for all instances (default every 15 s,
  `SHM_CMS_POLL_SECONDS` overrides; see
  [GUI instance management](gui-instance-management.md)). Each run is
  journaled and visible in the GUI operation history.

To drain manually, or on a headless schedule (one run drains every pending
operation for that instance, then exits):

```bash
sh-manager instance process-operations website1

# resident, supervised loop:
sh-manager instance process-operations website1 --watch --interval 15

# advanced: a remote/HTTP backend instead of the exec transport
sh-manager instance process-operations website1 \
  --backend-url http://127.0.0.1:PORT --token "$SELFHELP_MANAGER_TOKEN"
```

- The backend never trusts a browser-provided `instanceId`; cross-instance
  attempts are denied and logged.
- For headless servers without the resident GUI, wire a supervised trigger per
  instance — see [`deploy/`](../../deploy/README.md) for the ready-made systemd
  template unit (`--watch`) and cron example, and
  [operations-runbook](operations-runbook.md) ("Scheduling the update-operations
  loop").
- The CMS System page shows the **manager loop** health component ("last seen")
  and warns when a request sits on `requested` too long — that means no drain
  loop is running; start the persistent UI or the systemd unit.

## If an update fails

- A failed update **rolls back** automatically; the instance keeps running on the
  previous version. Re-run the dry run to see why.
- If the instance is unhealthy after a manual change, see
  [safe mode & recovery](safe-mode-and-recovery.md) and
  [backup & restore](backup-restore.md).
