# Deploy: manager update-operations trigger

Audience: Operators / release engineers
Status: Active
Applies to: `sh-manager` (manager tool `0.1.6+`)
Last verified: 2026-06-12
Source of truth: `apps/cli/src/bin.ts` (`instance process-operations`), `packages/core/src/operations.ts`

The CMS only ever **records** an instance-scoped update request; the manager is
the only component that touches Docker. Something has to run the manager's
`process-operations` consumer on a schedule, otherwise a CMS-requested update
stays on `requested` forever. These files wire that trigger for **headless**
servers; if the persistent web UI is running, its built-in poller already
drains all instances (see `docs/operator/gui-instance-management.md`) and you
do not need these units.

`sh-manager instance process-operations <id>` **drains every pending operation**
for one instance in a single run (claim -> execute -> write status back), then
exits. `--watch` keeps it resident and drains every `--interval` seconds. By
default it **execs into the instance's backend container** and authenticates
with the token generated at install — `SELFHELP_MANAGER_TOKEN` and
`SHM_OPERATIONS_EXTRA_ARGS=--backend-url ...` are only needed for remote/HTTP
setups.

Pick one of the two patterns below (do not run both for the same instance,
and do not combine either with a resident persistent UI for the same root).

## Option A - systemd (recommended)

A long-running, supervised loop per instance (`Restart=always`).

1. Install the template unit:

```bash
sudo cp deploy/systemd/sh-manager-operations@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

2. Optional — only for remote/HTTP transports: create the per-instance env
   file (mode `0600`, owned by the manager account). With the default exec
   transport **no env file is needed** (the unit marks it optional).

```bash
sudo install -d -m 0750 /etc/sh-manager
sudo tee /etc/sh-manager/<instance-id>.env >/dev/null <<'EOF'
# Only needed when the backend is reached over HTTP instead of compose exec:
SELFHELP_MANAGER_TOKEN=<the per-instance manager token>
SHM_OPERATIONS_EXTRA_ARGS=--backend-url http://127.0.0.1:8080
EOF
sudo chmod 0600 /etc/sh-manager/<instance-id>.env
```

3. Enable one unit per instance:

```bash
sudo systemctl enable --now sh-manager-operations@<instance-id>.service
sudo systemctl status sh-manager-operations@<instance-id>.service
journalctl -u sh-manager-operations@<instance-id>.service -f
```

Adjust `SELFHELP_MANAGER_ROOT` in the unit if your manager state root is not
`/var/lib/sh-manager`, and the `--interval` to taste (default 15s).

## Option B - cron (no systemd)

One-shot drain every minute per instance. Each tick claims and executes all
pending operations, then exits.

```bash
sudo install -d -m 0750 /var/log/sh-manager
# edit deploy/cron/sh-manager-operations.crontab.example: set <instance-id>
sudo crontab -u sh-manager deploy/cron/sh-manager-operations.crontab.example
```

The example sources the same optional `0600` env file as Option A so a token
(HTTP transport only) never appears in the crontab or the process list.

## Security notes

- The manager token is **per instance** (never a shared/global credential): one
  instance's loop can never read or write another's operations. Server-side scope
  re-verification rejects cross-instance operations even if a token leaks.
- Keep the env file `0600` and owned by the manager service account; never inline
  the token in the unit, crontab, or shell history.
- The loop needs the Docker socket and the manager state root only; the systemd
  unit ships with `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome`, and
  `PrivateTmp` on.

See also `docs/operator/operations-runbook.md` ("Scheduling the update-operations
loop") and `docs/developer/` for the CMS <-> manager update flow.
