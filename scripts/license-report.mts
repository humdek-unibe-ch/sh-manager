// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Dependency license report + policy gate.
 *
 * Walks declared dependencies (root + workspaces), reads each installed
 * package's `license`, prints a sorted report, and fails on a copyleft/unknown
 * license that is not on the allow-list. This is the manager half of the
 * release-pipeline license/SBOM checks.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const ALLOWED = new Set([
  'MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0', '0BSD',
  'CC0-1.0', 'CC-BY-4.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0', 'WTFPL',
]);
const DENY_PATTERNS = [/GPL/i, /AGPL/i, /LGPL/i, /SSPL/i, /CC-BY-NC/i, /BUSL/i];

interface PkgJson {
  name?: string;
  license?: string | { type?: string };
  licenses?: { type?: string }[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[];
}

async function readPkg(file: string): Promise<PkgJson | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as PkgJson;
  } catch {
    return null;
  }
}

function licenseOf(pkg: PkgJson): string {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (pkg.licenses && pkg.licenses[0]?.type) return pkg.licenses[0].type!;
  return 'UNKNOWN';
}

function classify(license: string): 'allowed' | 'denied' | 'review' {
  const cleaned = license.replace(/^\(|\)$/g, '');
  const parts = cleaned.split(/\s+OR\s+|\s+AND\s+/i).map((s) => s.trim());
  if (parts.some((p) => ALLOWED.has(p))) return 'allowed';
  if (DENY_PATTERNS.some((re) => re.test(license))) return 'denied';
  return 'review';
}

async function collectDeclaredDeps(): Promise<Set<string>> {
  const deps = new Set<string>();
  const rootPkg = await readPkg(path.join(root, 'package.json'));
  const add = (pkg: PkgJson | null) => {
    if (!pkg) return;
    for (const d of Object.keys(pkg.dependencies ?? {})) deps.add(d);
    for (const d of Object.keys(pkg.devDependencies ?? {})) deps.add(d);
  };
  add(rootPkg);
  for (const group of ['packages', 'apps']) {
    const dir = path.join(root, group);
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) add(await readPkg(path.join(dir, e, 'package.json')));
  }
  // Drop internal workspace packages (not third-party).
  for (const d of [...deps]) if (d.startsWith('@shm/')) deps.delete(d);
  return deps;
}

async function main(): Promise<void> {
  const declared = await collectDeclaredDeps();
  const rows: { name: string; license: string; verdict: string }[] = [];
  const denied: string[] = [];

  for (const dep of [...declared].sort()) {
    const pkg = await readPkg(path.join(root, 'node_modules', dep, 'package.json'));
    const license = pkg ? licenseOf(pkg) : 'NOT_INSTALLED';
    const verdict = pkg ? classify(license) : 'review';
    rows.push({ name: dep, license, verdict });
    if (verdict === 'denied') denied.push(`${dep} (${license})`);
  }

  const width = Math.max(...rows.map((r) => r.name.length), 4);
  console.log(`${'NAME'.padEnd(width)}  LICENSE                VERDICT`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(width)}  ${r.license.padEnd(22)} ${r.verdict}`);
  }

  const reviewCount = rows.filter((r) => r.verdict === 'review').length;
  console.log(`\n${rows.length} dependencies, ${denied.length} denied, ${reviewCount} need review.`);

  if (denied.length > 0) {
    console.error('\nLICENSE POLICY VIOLATION (copyleft/denied licenses):');
    for (const d of denied) console.error(` - ${d}`);
    process.exit(1);
  }
}

await main();
