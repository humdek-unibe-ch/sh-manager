// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared step plumbing for the update executors: the step record type and the
 * two internal helpers (`errMessage`, `emitStep`) used by BOTH the core and the
 * frontend execution paths. Kept here so `execute` and `frontend` do not depend
 * on each other.
 */

export type StepStatus = 'done' | 'failed' | 'skipped';
export interface UpdateStepResult {
  name: string;
  status: StepStatus;
  detail?: string;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record a step into the report AND notify the live-progress hook in one place,
 * so callers (the manager journal) see the step the instant it happens instead
 * of only in the final report. The hook is best-effort: a failure there must
 * never abort or alter the operation.
 */
export async function emitStep(
  steps: UpdateStepResult[],
  onStep: ((step: UpdateStepResult) => void | Promise<void>) | undefined,
  step: UpdateStepResult,
): Promise<void> {
  steps.push(step);
  if (!onStep) return;
  try {
    await onStep(step);
  } catch {
    // Progress reporting must never break the update.
  }
}
