// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * View-model helper that turns a journaled operation (`kind` + `phase` +
 * `status`) into a checklist of {@link ProgressStep}s for {@link StepProgress}.
 *
 * The server stays authoritative: every operation reports its coarse stage as
 * the journal `phase` (see the `ctx.setPhase(...)` calls in
 * `apps/web/src/instances.ts`), and this module only maps those phases onto
 * human-readable rows. The mapping is intentionally honest about what the
 * backend actually reports:
 *  - multi-phase kinds (create, restore) light up row-by-row as the phase
 *    advances;
 *  - single-phase kinds show their macro stages and tick them all on success,
 *    so the operator still gets the "these steps ran" checklist feel while the
 *    live log carries the fine-grained detail.
 *
 * Pure + deterministic so it is unit-testable without React or a real backend.
 */
import type { ProgressStep, StepState } from '../components';
import { CREATE_INSTANCE_STEPS, createStepIndexForPhase } from './wizard-view';
import type { OperationKind, OperationStatus } from './types';

interface StepDef {
  /** Matches the journal phase string (or its prefix) that activates this row. */
  id: string;
  label: string;
  note?: string;
}

/**
 * Per-kind macro checklist. The FIRST row's `id` always matches the kind's
 * initial `ctx.setPhase(...)` value so a running operation shows that row
 * active; later rows reflect the conceptual stages the backend then performs
 * (visible in the live log) and all tick green on success.
 */
const STEP_MAPS: Record<OperationKind, StepDef[]> = {
  // `instance_create` is handled specially (delegates to CREATE_INSTANCE_STEPS).
  instance_create: [],
  instance_update: [
    { id: 'plan', label: 'Resolve & plan update', note: 'Versions, migrations, plugin compatibility.' },
    { id: 'backup', label: 'Pre-update backup' },
    { id: 'pull', label: 'Pull verified images' },
    { id: 'recreate', label: 'Recreate containers' },
    { id: 'migrations', label: 'Run database migrations' },
    { id: 'health', label: 'Health check' },
  ],
  instance_frontend_update: [
    { id: 'plan', label: 'Resolve & plan frontend update' },
    { id: 'pull', label: 'Pull verified frontend image' },
    { id: 'recreate', label: 'Recreate frontend container' },
    { id: 'health', label: 'Health check' },
  ],
  instance_mobile_preview_update: [
    { id: 'plan', label: 'Resolve & plan mobile preview update' },
    { id: 'pull', label: 'Pull verified mobile-preview image' },
    { id: 'recreate', label: 'Recreate mobile-preview container' },
    { id: 'health', label: 'Health check' },
  ],
  instance_backup: [
    { id: 'database', label: 'Dump database' },
    { id: 'metadata', label: 'Snapshot manifest, lock & config' },
    { id: 'volumes', label: 'Archive uploads & plugin artifacts' },
    { id: 'manifest', label: 'Write manifest & checksums' },
  ],
  instance_scheduled_backup: [{ id: 'scheduled backup', label: 'Run scheduled backup' }],
  instance_backup_prune: [{ id: 'prune backups', label: 'Apply retention & prune backups' }],
  instance_restore: [
    { id: 'pre-restore backup', label: 'Pre-restore safety backup' },
    { id: 'verify', label: 'Verify backup integrity' },
    { id: 'stop', label: 'Stop instance (volumes kept)' },
    { id: 'volumes', label: 'Restore uploads & plugin artifacts' },
    { id: 'database', label: 'Import database' },
    { id: 'config', label: 'Restore configuration & inventory' },
    { id: 'recreate', label: 'Start restored stack' },
    { id: 'migrate', label: 'Forward-migrate if needed', note: 'Only when the DB head differs.' },
    { id: 'health', label: 'Health check' },
  ],
  instance_clone: [
    { id: 'plan', label: 'Resolve & plan clone', note: 'Pin source versions; fresh secrets and a new address.' },
    { id: 'secrets', label: 'Generate secrets & write config' },
    { id: 'volumes', label: 'Copy uploads & plugin artifacts' },
    { id: 'database', label: 'Copy database', note: 'Source stays running (read-only dump).' },
    { id: 'recreate', label: 'Start the clone stack' },
    { id: 'health', label: 'Health check' },
  ],
  instance_set_address: [{ id: 'apply address', label: 'Apply address & recreate containers' }],
  instance_set_mailer: [{ id: 'apply mailer', label: 'Apply mailer & restart' }],
  instance_set_name: [{ id: 'rename', label: 'Rename instance' }],
  instance_set_env: [{ id: 'apply environment', label: 'Apply environment & recreate containers' }],
  instance_disable: [{ id: 'disable', label: 'Stop containers (all data kept)' }],
  instance_enable: [{ id: 'enable', label: 'Start containers & restore plugins' }],
  instance_safe_mode: [{ id: 'safe-mode', label: 'Toggle safe mode (plugins on/off)' }],
  instance_plugin_recover: [{ id: 'plugin-recover', label: 'Recover plugins (safe mode → repair → verify boot)' }],
  instance_remove: [{ id: 'remove', label: 'Remove instance' }],
  cms_operations_drain: [{ id: 'drain', label: 'Process pending CMS & plugin operations' }],
};

/**
 * Friendly display label for an operation kind. Most kinds read fine as
 * `kind.replace(/_/g, ' ')`, but `cms_operations_drain` is operator jargon —
 * it is really "the manager applied a plugin/CMS change you requested in the
 * admin UI", so we give it a clearer name. The live phase (set by the drain)
 * carries the specifics ("Installing plugin X 0.2.1").
 */
export function operationKindLabel(kind: string): string {
  if (kind === 'cms_operations_drain') return 'Plugin / CMS operation';
  // Spell out the core update so it is unmistakably a core-stack update (vs. the
  // `instance_frontend_update` frontend-only swap) in the operation history.
  if (kind === 'instance_update') return 'instance core update';
  if (kind === 'instance_plugin_recover') return 'plugin recovery';
  if (kind === 'instance_safe_mode') return 'safe mode';
  return kind.replace(/_/g, ' ');
}

/** Minimal operation slice this view-model needs. */
export interface OperationStepInput {
  kind: OperationKind;
  phase: string;
  status: OperationStatus;
}

/** Index of the active checklist row for a journal phase (exact id, else prefix). */
function activeIndex(steps: StepDef[], phase: string | undefined): number {
  if (!phase) return 0;
  const exact = steps.findIndex((s) => s.id === phase);
  if (exact >= 0) return exact;
  // Dynamic phases like `remove (delete)` carry a suffix → match on the prefix.
  const prefixed = steps.findIndex((s) => phase.startsWith(s.id));
  return prefixed < 0 ? 0 : prefixed;
}

function toState(index: number, active: number, status: OperationStatus): StepState {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return index < active ? 'success' : index === active ? 'failed' : 'waiting';
  return index < active ? 'success' : index === active ? 'running' : 'waiting';
}

/**
 * Build the checklist for an operation. Returns `[]` for kinds without a step
 * map (the caller then renders nothing).
 */
export function buildOperationSteps(op: OperationStepInput): ProgressStep[] {
  if (op.kind === 'instance_create') {
    const active = createStepIndexForPhase(op.phase);
    return CREATE_INSTANCE_STEPS.map((s, i) => ({
      id: s.id,
      label: s.label,
      state: toState(i, active, op.status),
      ...(s.note ? { note: s.note } : {}),
    }));
  }

  const steps = STEP_MAPS[op.kind];
  if (!steps || steps.length === 0) return [];
  const active = activeIndex(steps, op.phase);
  return steps.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: toState(i, active, op.status),
    ...(s.note ? { note: s.note } : {}),
  }));
}
