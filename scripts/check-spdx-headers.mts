// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * License-header gate (the manager's equivalent of the backend's
 * `composer headers:check`): every tracked source file must carry the
 * MPL-2.0 SPDX header. Runs as part of `npm run check` and CI.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const SOURCE_FILE = /\.(ts|tsx|mts|mjs|cjs|js|css|html|yml|yaml)$|(^|\/)Dockerfile$/;

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const missing: string[] = [];
let checked = 0;

for (const file of files) {
  if (!SOURCE_FILE.test(file)) continue;
  // Skip files that are still tracked but no longer on disk (deleted but the
  // removal is not committed yet) — the gate checks present source files, it
  // must not crash on a pending deletion.
  if (!existsSync(file)) continue;
  checked += 1;
  const head = readFileSync(file, 'utf8').slice(0, 400);
  if (!head.includes('SPDX-License-Identifier: MPL-2.0')) missing.push(file);
}

if (missing.length > 0) {
  console.error(`Missing MPL-2.0 SPDX header in ${missing.length} file(s):`);
  for (const file of missing) console.error(`  ${file}`);
  console.error('\nAdd at the top of each file:');
  console.error('  SPDX-FileCopyrightText: 2026 Humdek, University of Bern');
  console.error('  SPDX-License-Identifier: MPL-2.0');
  process.exit(1);
}

console.log(`SPDX headers OK (${checked} source files checked).`);
