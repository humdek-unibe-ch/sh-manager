// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Release version guard (`npm run version:check`).
 *
 * Fails when the git tag being released does not match the version baked into
 * the code (root `package.json` + `MANAGER_VERSION`). This is the safety net the
 * `v1.6.2` release was missing: it was tagged `v1.6.2` while the code still
 * reported `1.6.1`, so the published image's self-reported version (the CLI
 * `--version`, the web console header, inventory stamps, and the "current
 * version" `self-update` compares against) disagreed with its tag — operators
 * who updated kept seeing the old version.
 *
 * The tag is read from the first CLI arg, then `RELEASE_TAG`, then
 * `GITHUB_REF_NAME` (set automatically on a tag push in GitHub Actions).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANAGER_VERSION, releaseVersionMismatch } from '@shm/schemas';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const tag = (process.argv[2] ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME ?? '').trim();
if (!tag) {
  console.error(
    'version:check: no release tag to verify. Pass it as an argument, or set RELEASE_TAG / GITHUB_REF_NAME\n' +
      '  e.g. npm run version:check -- v1.6.2',
  );
  process.exit(1);
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
const reason = releaseVersionMismatch(tag, pkg.version, MANAGER_VERSION);
if (reason) {
  console.error(`version:check: ${reason}`);
  process.exit(1);
}

console.log(
  `version:check: OK — tag ${tag} matches package.json ${pkg.version} and MANAGER_VERSION ${MANAGER_VERSION}.`,
);
