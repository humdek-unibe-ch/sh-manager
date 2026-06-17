// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared CLI command context: the two bin-local, side-effecting helpers passed
 * to every command registrar so the registrars stay free of process / trusted-key
 * wiring. `deps` builds the real {@link ActionDeps} for a state root (loads the
 * default trusted keys + engine-root mapping); `fail` prints a friendly error and
 * exits non-zero. Path-sensitive defaults (the trusted-keys location, derived
 * from the bin file's own location) deliberately stay in `bin.ts`.
 */
import type { ActionDeps } from '@shm/app-actions';

export interface CliContext {
  /** Build the real ActionDeps for a state root (trusted keys + engine mapping). */
  deps: (root: string) => Promise<ActionDeps>;
  /** Print a friendly error to stderr and exit with a non-zero status. */
  fail: (err: unknown) => never;
}
