# Release & publishing

Audience: Developers / maintainers
Status: Active
Applies to: `sh-manager` (manager tool `0.1.5`) and the SelfHelp 0.x pre-release platform line
Last verified: 2026-06-11
Source of truth: `packages/registry/src`, `packages/schemas/src`, `scripts/sign-fixtures.mts`, `package.json`, and (registry side) `sh2-plugin-registry/.github/workflows/publish-core-release.yml`

This page explains how versions, signatures, and the registry fit together, and
how the manager itself is released. The **registry-side** publishing steps (how a
release JSON gets signed and pushed to the official catalogue) live in the
`sh2-plugin-registry` repository — see its publishing guide
(`docs/operations/publishing.md`) and signing guide (`docs/operations/signing.md`)
at <https://github.com/humdek-unibe-ch/sh2-plugin-registry>.

## Two version axes

Do not conflate these:

1. **The manager tool** uses its own semver — currently **`0.1.0`**. Releases in
   the registry declare a `requiresManager` constraint (for example
   `>=0.1.0`); the manager refuses artifacts that require a newer manager than is
   installed. Because `requiresManager` is a hard compatibility gate, the tool's
   semver is part of a contract — do not bump it casually.
2. **The SelfHelp platform** is currently the pre-release **`0.x`** line. The
   manager installs and updates the platform artifacts (core, frontend,
   scheduler, worker) at their own `0.x` versions (currently `0.1.0`), resolved
   from the registry. There is no `8.x` distribution; "SelfHelp 8" was an earlier
   working label and is not a current version.

A single manager `0.1.0` installs and manages SelfHelp `0.x` pre-release instances.

## The signing & trust model

Everything the manager installs is verified before it is used:

- **Canonical JSON** (`@shm/registry`) produces a deterministic byte
  representation of a release payload. It is byte-compatible with the registry
  signer and the host PHP `SignedPayloadBuilder`, so a signature made anywhere
  verifies everywhere.
- **Ed25519 signatures** sign the canonical payload. The client verifies them
  against the **trusted keys** file (`SELFHELP_TRUSTED_KEYS`).
- **SHA-256 checksums** cover the artifacts. Both signature and checksum must pass
  before an artifact is unpacked/used.
- In production the client **refuses** unsigned, untrusted, or `dev`-keyed
  releases.
- **Advisories** in the registry can block or warn on a version; the resolver
  honours them during install and update.

### Compatibility fields

The resolver reads compatibility metadata from each release, including:

- `requiresManager` — the minimum (and optionally maximum) manager version.
- core ⇄ frontend ⇄ plugin ⇄ plugin-API compatibility constraints.

These are validated by `@shm/schemas` and exercised by the resolver tests
(`packages/resolver/src/*.test.ts`, `packages/schemas/src/validate.test.ts`).

## Test fixtures (local signing)

The offline test suite uses a **signed fixture registry** so it can verify the
full signature path with no network. Regenerate the fixtures (and their
signatures) with:

```bash
npm run fixtures:sign
```

This re-signs `packages/schemas/examples/*` with the example keys. The example
trusted-keys file is for tests only — never use the example keys for a real
release.

## Releasing the manager

The manager ships as the single privileged Docker image
(`ghcr.io/humdek-unibe-ch/sh-manager`). Release flow:

1. Bump the version in exactly **two** places (they must match):
   - `packages/schemas/src/version.ts` → `MANAGER_VERSION` — the single
     source of truth the CLI (`--version`), web UI, inventory stamps, and
     `requiresManager` checks all import;
   - the root `package.json` `version`.
2. Land changes with the gate green: `npm run check`
   (typecheck + lint + test + schema validation) and `npm run build`.
3. Update [`CHANGELOG.md`](../CHANGELOG.md) (versioning blurb + a new section).
4. Tag the release (`v<version>`) and let CI build and publish the image.
5. If the change alters a compatibility contract (`requiresManager`, schema
   versions, lock/manifest shape), coordinate it with the registry catalogue and
   the platform repos per the cross-repo compatibility process.

Operators discover a new release via `sh-manager self-update` (CLI, exit `2`
when an update exists) or the "Manager version" card in the web operations
console — both check the GitHub releases feed of this repository.

## Publishing platform artifacts (core / frontend / scheduler / worker / plugins)

Building and publishing the **artifacts** the manager installs is done in the
`sh2-plugin-registry` repository, not here. That includes core, frontend,
scheduler, worker, and plugin releases, their checksums and signatures, the
trusted-keys file, advisories, and compatibility fields such as `requiresManager`.
See that repository's `docs/operations/publishing.md`,
`docs/reference/registry-layout.md`, and `CHANGELOG.md`
(<https://github.com/humdek-unibe-ch/sh2-plugin-registry>).

### Real public release (reviewed, manual) vs. rehearsal (`test` channel)

There are two distinct paths, and they never cross:

- **Real public release** — build + push the images (in `sh-selfhelp_backend`
  `docker-release.yml` and `sh-selfhelp_frontend` `frontend-release.yml`), capture
  the digests, then run the registry's **`publish-core-release`** workflow
  (`workflow_dispatch`). It assembles + signs with the **production** key (repo
  secret), validates, and opens a **reviewed pull request** — it never auto-merges
  and never publishes Pages; a human merge does. The end-to-end runbook with the
  do-not-auto-publish caveats is the registry's
  `docs/operations/publishing.md` ("Real public release: end-to-end runbook").
- **Rehearsal** — exercise the full publish → install → update → backup/restore/
  clone/rollback pipeline on the **`test`** channel against locally-built `:e2e`
  images and a **dev-signed, locally-served** registry. This never touches the
  public registry or the production key. The copy-paste runbook is
  [`operator/rehearsal-publish-install-update.md`](operator/rehearsal-publish-install-update.md);
  the automated equivalent is the manager Docker e2e (`SHM_E2E=1 npm run e2e`,
  `.github/workflows/e2e-docker.yml`).
