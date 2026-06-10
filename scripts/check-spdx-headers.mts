// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * License-header gate (the manager's equivalent of the backend's
 * `composer headers:check`): every tracked source file must carry the
 * MPL-2.0 SPDX header. Runs as part of `npm run check` and CI.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SOURCE_FILE = /\.(ts|tsx|mts|mjs|cjs|js|css|html|yml|yaml)$|(^|\/)Dockerfile$/;

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const missing: string[] = [];

for (const file of files) {
  if (!SOURCE_FILE.test(file)) continue;
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

console.log(`SPDX headers OK (${files.filter((f) => SOURCE_FILE.test(f)).length} source files checked).`);
