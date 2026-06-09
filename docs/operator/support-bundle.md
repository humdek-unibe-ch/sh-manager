# Collect a support bundle

Audience: Server operators
Status: Active
Applies to: `sh-manager` (manager tool `0.1.0`)
Last verified: 2026-06-08
Source of truth: `apps/cli/src/bin.ts`, `packages/support/src`

A support bundle is a **redacted** snapshot of an instance's configuration and
diagnostics that is safe to share with the SelfHelp team.

## Create a bundle

```bash
sh-manager instance support-bundle website1
# Support bundle: /opt/selfhelp/instances/website1/support/<timestamp>
# Files: manifest.json, compose.redacted.yml, env.redacted, health.json, ...
```

## What it contains

- Instance manifest and lock (versions, pinned digests) — no secrets.
- The Docker Compose file and `.env` with **secrets redacted**.
- Health and preflight results.
- Relevant logs/config needed to diagnose the issue.

## Redaction guarantee

Secrets are redacted **and the assembled bundle is re-scanned** for residual
secrets before it is written. If the scan finds anything that looks like a secret,
the bundle is not produced. Even so:

- Review the files before sending them.
- Send the bundle through a private channel, not a public issue tracker.

## What to include when you ask for help

- The support bundle directory (zip it up).
- What you were doing (install / update / restore / clone) and the exact command.
- The output of `sh-manager instance health <id>` and `sh-manager doctor`.
