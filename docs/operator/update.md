# Update an instance

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`)
Last verified: 2026-06-08
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
UI, it records an **instance-scoped** operation. The manager claims and executes
every pending operation for exactly that instance (one run drains the queue):

```bash
sh-manager instance process-operations website1 \
  --backend-url http://127.0.0.1:PORT \
  --token "$SELFHELP_MANAGER_TOKEN"

# Or run it as a resident, supervised loop:
sh-manager instance process-operations website1 \
  --backend-url http://127.0.0.1:PORT --watch --interval 15
```

- The per-instance token authenticates the manager to a single instance's
  backend (`--token` or `SELFHELP_MANAGER_TOKEN`).
- The backend never trusts a browser-provided `instanceId`; cross-instance
  attempts are denied and logged.
- A request stays on `requested` until the manager processes it, so wire this
  into a supervised trigger per instance — see [`deploy/`](../../deploy/README.md)
  for the ready-made systemd template unit (`--watch`) and cron example, and
  [operations-runbook](operations-runbook.md) ("Scheduling the update-operations
  loop").

## If an update fails

- A failed update **rolls back** automatically; the instance keeps running on the
  previous version. Re-run the dry run to see why.
- If the instance is unhealthy after a manual change, see
  [safe mode & recovery](safe-mode-and-recovery.md) and
  [backup & restore](backup-restore.md).
