<!--
SPDX-FileCopyrightText: 2026 Humdek, University of Bern
SPDX-License-Identifier: MPL-2.0
-->

# Manual QA results — release sign-off

Audience: QA testers and release engineers
Status: Template (copy per release; do not fill in this file)
Applies to: `sh-manager` (manager tool `1.4.0+`)
Last verified: 2026-06-13
Source of truth: [manual-test-plan.md](manual-test-plan.md)

Copy this file to `results-<version>-<platform>.md` (e.g.
`results-1.4.0-linux.md`), fill it in while executing the
[manual test plan](manual-test-plan.md), and attach it to the release record.
One copy per platform.

## Run metadata

| Field | Value |
|---|---|
| Manager version under test | `vX.Y.Z` (image digest: `sha256:…`) |
| Platform | Linux distro + Docker version / Windows + Docker Desktop version |
| Tester | name |
| Date(s) | YYYY-MM-DD |
| Registry used | official / local test registry |
| Automated gates green? | CI run link + nightly e2e run link |

## Verdict

- [ ] **PASS** — all Critical and High cases passed (or have an approved,
  linked waiver). Release may proceed.
- [ ] **FAIL** — at least one unwaived Critical/High failure. Release blocked.

Summary (one paragraph: what was run, what was skipped and why, overall
confidence):

> …

## Results

Status values: `pass` / `fail` / `blocked` (preconditions unmeetable) /
`skipped` (justify). Every `fail` needs an issue link; every `blocked`/
`skipped` needs a reason.

### QA-BOOT — Server bootstrap

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-BOOT-001 | | | |
| QA-BOOT-002 | | | |
| QA-BOOT-003 | | | |
| QA-BOOT-004 | | | |

### QA-INST — Instance install

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-INST-001 | | | |
| QA-INST-002 | | | |
| QA-INST-003 | | | |
| QA-INST-004 | | | |

### QA-HLTH — Health

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-HLTH-001 | | | |
| QA-HLTH-002 | | | |

### QA-BKP — Manual backups

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-BKP-001 | | | |
| QA-BKP-002 | | | |
| QA-BKP-003 | | | |

### QA-SCHED — Scheduled backups + retention

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-SCHED-001 | | | |
| QA-SCHED-002 | | | |
| QA-SCHED-003 | | | |
| QA-SCHED-004 | | | |
| QA-SCHED-005 | | | |
| QA-SCHED-006 | | | |

### QA-RST — Restore

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-RST-001 | | | |
| QA-RST-002 | | | |
| QA-RST-003 | | | |
| QA-RST-004 | | | |

### QA-CLN — Clone

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-CLN-001 | | | |
| QA-CLN-002 | | | |

### QA-UPD — Update

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-UPD-001 | | | |
| QA-UPD-002 | | | |
| QA-UPD-003 | | | |
| QA-UPD-004 | | | |

### QA-ADDR — Address changes

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-ADDR-001 | | | |
| QA-ADDR-002 | | | |

### QA-MAIL — Outbound mail

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-MAIL-001 | | | |
| QA-MAIL-002 | | | |
| QA-MAIL-003 | | | |

### QA-PLUG — Plugin operations

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-PLUG-001 | | | |
| QA-PLUG-002 | | | |
| QA-PLUG-003 | | | |
| QA-PLUG-004 | | | |

### QA-SAFE — Safe mode

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-SAFE-001 | | | |
| QA-SAFE-002 | | | |

### QA-SUP — Support bundle

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-SUP-001 | | | |
| QA-SUP-002 | | | |

### QA-GUI — Web console

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-GUI-001 | | | |
| QA-GUI-002 | | | |
| QA-GUI-003 | | | |
| QA-GUI-004 | | | |
| QA-GUI-005 | | | |

### QA-WRAP — Wrapper lifecycle

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-WRAP-001 | | | |
| QA-WRAP-002 | | | |
| QA-WRAP-003 | | | |

### QA-RMV — Remove modes

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-RMV-001 | | | |
| QA-RMV-002 | | | |
| QA-RMV-003 | | | |

### QA-PURGE — Server purge

| Case | Status | Evidence / notes | Issue |
|---|---|---|---|
| QA-PURGE-001 | | | |
| QA-PURGE-002 | | | |

## Evidence rules

- Attach command output / screenshots in a sibling `evidence/` folder and
  link them from the notes column.
- NEVER include secrets (passwords, DSNs with credentials, tokens, key
  material) in this file or in evidence. Redact before saving — the support
  bundle's redaction rules are the model.

## Sign-off

| Role | Name | Date | Signature/approval link |
|---|---|---|---|
| Tester | | | |
| Release engineer | | | |
