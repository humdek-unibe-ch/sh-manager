#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * SelfHelp Manager web entrypoint (`sh-manager-web`).
 *
 * Thin argv shim over {@link startWebUi} (the shared composition root in
 * `main.ts`, also used by the CLI's `sh-manager web` subcommand).
 */
import { startWebUi } from './main.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const port = arg('port');

startWebUi({
  ...(arg('root') !== undefined ? { root: arg('root') } : {}),
  ...(arg('host') !== undefined ? { host: arg('host') } : {}),
  ...(port !== undefined ? { port: Number(port) } : {}),
  ...(flag('allow-non-local') ? { allowNonLocal: true } : {}),
  ...(arg('client-dir') !== undefined ? { clientDir: arg('client-dir') } : {}),
  ...(arg('trusted-keys') !== undefined ? { trustedKeysPath: arg('trusted-keys') } : {}),
}).catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
