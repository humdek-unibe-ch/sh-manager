// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Copies the non-TypeScript runtime assets into dist/ after `tsc` so the
 * compiled tree is fully self-contained. Both CLI and web entrypoints resolve
 * their default trusted-keys file relative to the compiled bin.js
 * (`dist/packages/schemas/...`); without this copy the Docker image fails at
 * startup with ENOENT (the v0.1.1 regression).
 */
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const rel of ['packages/schemas/examples', 'packages/schemas/keys']) {
  const from = path.join(root, rel);
  const to = path.join(root, 'dist', rel);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  process.stdout.write(`copied ${rel} -> dist/${rel}\n`);
}
