// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Argv-level regression tests for the real `sh-manager` entrypoint.
 *
 * These exist because commander wiring bugs are invisible to the action-level
 * tests (which call the package functions directly): a globally registered
 * `--version` flag swallowed `instance install --version <x>` and the CLI
 * printed the manager version and exited instead of installing. Spawning the
 * actual bin is the only test that exercises the parse.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MANAGER_VERSION } from '@shm/schemas';

const execFileAsync = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const bin = path.join(repoRoot, 'apps', 'cli', 'src', 'bin.ts');

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [tsxCli, bin, ...args], {
      cwd: repoRoot,
      timeout: 60_000,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

describe('sh-manager argv parsing', () => {
  it('does NOT hijack `instance install --version <x>` for the root version flag', async () => {
    // No --id: with correct parsing commander must complain about the missing
    // required option. With the old global --version flag it printed the
    // manager version and exited 0 — the install never even started.
    const res = await runCli(['instance', 'install', '--version', 'latest']);
    expect(res.stdout.trim()).not.toBe(MANAGER_VERSION);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("required option '--id <id>' not specified");
  }, 60_000);

  it('prints the manager version for a bare `sh-manager --version`', async () => {
    const res = await runCli(['--version']);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe(MANAGER_VERSION);
  }, 60_000);
});
