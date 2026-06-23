// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Pure CMS-phase mapping helpers shared by the adapter (live operation
 * streaming) and the BFF/poller. Kept in their own leaf module so the adapter
 * can use {@link cmsUpdatePhaseStep} without a value cycle back into
 * `instances.ts`.
 */
import type { InstanceSummary } from '../instances.js';

/** True when an inventory entry should be drained by the CMS poller. */
export function isPollable(summary: InstanceSummary): boolean {
  return summary.status === 'active' && summary.busy === null;
}

/**
 * Maps a CMS update's coarse lifecycle status onto the manager journal step id
 * for {@link buildOperationSteps} (the `instance_update` /
 * `instance_frontend_update` step maps), so the operator's live checklist
 * advances row-by-row. Returns `null` for statuses with no dedicated row
 * (terminal states are reflected by the operation's own success/failure).
 *
 * `mobile-preview` is a lightweight, stateless swap like `frontend`: it takes no
 * backup and runs no migrations, so it skips those rows.
 */
export function cmsUpdatePhaseStep(
  kind: 'core' | 'frontend' | 'mobile-preview' | undefined,
  status: string,
): string | null {
  const lightweight = kind === 'frontend' || kind === 'mobile-preview';
  switch (status) {
    case 'accepted':
    case 'preflight_running':
      return 'plan';
    case 'backup_running':
      return lightweight ? null : 'backup';
    case 'update_running':
      return 'pull';
    case 'migration_running':
      return lightweight ? null : 'migrations';
    case 'health_check_running':
      return 'health';
    default:
      return null;
  }
}
