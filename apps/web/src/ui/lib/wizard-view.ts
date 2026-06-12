// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Presentational copy + view-model helpers for the create-instance wizard.
 * The server stays the single source of truth for behavior (validation lives
 * in `instance-validation.ts`, install phases in the operation journal); this
 * module only supplies human labels and maps journal phases onto checklist
 * rows.
 */

export interface CheckMeta {
  title: string;
  description: string;
  /** Shown when the check fails — a concrete, non-scary next action. */
  fix: string;
}

/** Copy for the preflight checks (POST /api/server/preflight). */
export const CHECK_META: Record<string, CheckMeta> = {
  docker: {
    title: 'Docker engine & Compose',
    description: 'SelfHelp runs as isolated Docker containers managed with Compose v2.',
    fix: 'Install Docker Engine and the Compose v2 plugin, then start the Docker service.',
  },
  internet: {
    title: 'Outbound internet access',
    description: 'Required to download verified container images and the release registry.',
    fix: 'Allow outbound HTTPS (443) from this server, or configure a proxy.',
  },
  registry: {
    title: 'Official registry & signatures',
    description: 'Releases are verified against the official SelfHelp signing keys before install.',
    fix: 'Check the registry URL is reachable and that the trusted-keys file is present.',
  },
  resources: {
    title: 'System resources',
    description: 'Disk, memory and required ports are checked before anything is created.',
    fix: 'Free up disk/RAM, or release the required ports, then run the check again.',
  },
};

/** Presentational steps shown on the install-progress screen. */
export interface InstallStepView {
  id: string;
  label: string;
  note?: string;
}

/**
 * Checklist rows for the create-instance install screen, driven by the REAL
 * journaled operation phase: `instanceInstall` reports each stage (via
 * `onStep`) and the journal stores it as `OperationRecord.phase`.
 */
export const CREATE_INSTANCE_STEPS: InstallStepView[] = [
  { id: 'registry', label: 'Resolve & verify release', note: 'Signatures are checked against the official registry.' },
  { id: 'compose', label: 'Generate configuration & secrets', note: 'Secrets go to restricted files — never shown here.' },
  { id: 'start', label: 'Pull verified images & start services' },
  { id: 'wait_db', label: 'Wait for the database' },
  { id: 'migrations', label: 'Run database migrations' },
  { id: 'admin', label: 'Create the first admin account' },
  { id: 'plugins', label: 'Install initial plugins' },
  { id: 'cache_warm', label: 'Warm caches & restart backend' },
  { id: 'health', label: 'Run health checks' },
];

/**
 * Journal phases that predate the first real stage (treated as step 0).
 * `server init` is journalled when the first install also bootstraps the
 * server (proxy + inventory).
 */
const CREATE_PRELUDE_PHASES = new Set(['starting', 'server init', 'install', 'seed']);

/**
 * Index of the ACTIVE checklist row for a journaled create-operation phase.
 * Unknown phases (and the journal's generic prelude phases) map onto the
 * first row so the checklist always shows forward motion; `seed` (skipped on
 * normal installs, journalled between migrations and admin) sticks to the
 * migrations row.
 */
export function createStepIndexForPhase(phase: string | undefined): number {
  if (!phase) return 0;
  if (phase === 'seed') return CREATE_INSTANCE_STEPS.findIndex((s) => s.id === 'migrations');
  if (CREATE_PRELUDE_PHASES.has(phase)) return 0;
  const idx = CREATE_INSTANCE_STEPS.findIndex((s) => s.id === phase);
  return idx < 0 ? 0 : idx;
}
