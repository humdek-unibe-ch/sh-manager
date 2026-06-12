// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Pre-parse argv normalisation for the sh-manager CLI.
 */

/**
 * Drops one redundant leading `sh-manager` token from user argv
 * (`./shm.ps1 sh-manager instance list`): docs and muscle memory make
 * operators type the binary name even though the wrapper / image entrypoint
 * already IS the manager, and commander would reject it with
 * `unknown command 'sh-manager'`. Only the first user token (argv[2]) is
 * considered, so positional values like an instance actually named
 * `sh-manager` are never touched.
 */
export function stripRedundantManagerToken(argv: string[]): string[] {
  return argv[2] === 'sh-manager' ? [...argv.slice(0, 2), ...argv.slice(3)] : argv;
}
