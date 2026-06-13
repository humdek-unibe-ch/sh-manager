// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * GFS (grandfather-father-son) retention for instance backups.
 *
 * Pure classification: given the backups that exist and the retention policy,
 * produce an explicit, auditable keep/prune plan (every decision carries its
 * reason). The executor deletes ONLY what this plan lists — and the plan obeys
 * hard safety invariants:
 *
 *   - `manual` backups are NEVER pruned.
 *   - safety backups (`pre_update`/`pre_restore`) are pruned only past max age.
 *   - the newest scheduled backup is NEVER pruned (an instance with a working
 *     schedule always keeps at least its latest safety point), regardless of age.
 *   - only `scheduled` backups participate in the GFS slot competition.
 *
 * Slot model (local calendar, matching the schedule's local-time semantics):
 *   - daily:   every scheduled backup from the most recent `daily` distinct days.
 *   - weekly:  the newest backup of each of the most recent `weekly` Mondays.
 *   - monthly: the newest backup of each of the most recent `monthly` 1st-of-month days.
 *   - a backup taken on a Monday that is also the 1st serves both; the monthly
 *     role wins for display.
 *   - `maxAgeDays` is a hard cap that overrides slot membership (except the
 *     newest-scheduled invariant).
 */
import type { BackupOrigin, BackupRetentionPolicy } from '@shm/schemas';

export interface BackupCandidate {
  backupId: string;
  /** ISO timestamp; interpreted in the manager server's local time zone. */
  createdAt: string;
  /** Resolved origin (callers map a legacy manifest without origin to manual). */
  origin: BackupOrigin;
}

export type KeepReason =
  | 'manual'
  | 'safety-within-max-age'
  | 'newest-scheduled'
  | 'monthly'
  | 'weekly'
  | 'daily';

export type PruneReason = 'beyond-retention' | 'older-than-max-age';

export interface RetentionDecision {
  backupId: string;
  origin: BackupOrigin;
  createdAt: string;
  action: 'keep' | 'prune';
  /** Keep: every role the backup fills. Prune: exactly one reason. */
  reasons: (KeepReason | PruneReason)[];
}

export interface PrunePlan {
  keep: RetentionDecision[];
  prune: RetentionDecision[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local-calendar day key, e.g. "2026-06-05". */
function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function monthKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

/**
 * Classifies every backup as keep (with all its roles) or prune (with the
 * single reason). The result is exhaustive: every candidate appears exactly
 * once across `keep` + `prune`.
 */
export function planPrune(
  candidates: BackupCandidate[],
  retention: BackupRetentionPolicy,
  now: Date,
): PrunePlan {
  const sorted = [...candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep: RetentionDecision[] = [];
  const prune: RetentionDecision[] = [];

  const ageDays = (c: BackupCandidate): number => (now.getTime() - new Date(c.createdAt).getTime()) / DAY_MS;

  const scheduled = sorted.filter((c) => c.origin === 'scheduled');
  const newestScheduledId = scheduled[0]?.backupId;

  // --- GFS slot membership for scheduled backups (computed on local days). ---
  const byDay = new Map<string, BackupCandidate[]>(); // newest first within a day
  for (const c of scheduled) {
    const key = dayKey(new Date(c.createdAt));
    const list = byDay.get(key);
    if (list) list.push(c);
    else byDay.set(key, [c]);
  }
  const daysDesc = [...byDay.keys()].sort((a, b) => b.localeCompare(a));

  const dailyDays = new Set(daysDesc.slice(0, retention.daily));

  const weeklyReps = new Set<string>();
  let weeklyTaken = 0;
  for (const day of daysDesc) {
    if (weeklyTaken >= retention.weekly) break;
    const rep = byDay.get(day)![0]!;
    if (new Date(rep.createdAt).getDay() !== 1) continue; // Mondays only
    weeklyReps.add(rep.backupId);
    weeklyTaken++;
  }

  const monthlyReps = new Set<string>();
  const monthsTaken = new Set<string>();
  for (const day of daysDesc) {
    if (monthsTaken.size >= retention.monthly) break;
    const rep = byDay.get(day)![0]!;
    const created = new Date(rep.createdAt);
    if (created.getDate() !== 1) continue; // 1st of the month only
    const month = monthKey(created);
    if (monthsTaken.has(month)) continue;
    monthsTaken.add(month);
    monthlyReps.add(rep.backupId);
  }

  for (const c of sorted) {
    const tooOld = ageDays(c) > retention.maxAgeDays;

    if (c.origin === 'manual') {
      keep.push({ ...decisionBase(c), action: 'keep', reasons: ['manual'] });
      continue;
    }

    if (c.origin === 'pre_update' || c.origin === 'pre_restore') {
      if (tooOld) prune.push({ ...decisionBase(c), action: 'prune', reasons: ['older-than-max-age'] });
      else keep.push({ ...decisionBase(c), action: 'keep', reasons: ['safety-within-max-age'] });
      continue;
    }

    // scheduled
    const reasons: KeepReason[] = [];
    if (c.backupId === newestScheduledId) reasons.push('newest-scheduled');
    if (!tooOld) {
      // Monthly wins the display order, then weekly, then daily.
      if (monthlyReps.has(c.backupId)) reasons.push('monthly');
      if (weeklyReps.has(c.backupId)) reasons.push('weekly');
      if (dailyDays.has(dayKey(new Date(c.createdAt)))) reasons.push('daily');
    }
    if (reasons.length > 0) {
      keep.push({ ...decisionBase(c), action: 'keep', reasons });
    } else {
      prune.push({
        ...decisionBase(c),
        action: 'prune',
        reasons: [tooOld ? 'older-than-max-age' : 'beyond-retention'],
      });
    }
  }

  return { keep, prune };
}

function decisionBase(c: BackupCandidate): Pick<RetentionDecision, 'backupId' | 'origin' | 'createdAt'> {
  return { backupId: c.backupId, origin: c.origin, createdAt: c.createdAt };
}

// ---------------------------------------------------------------------------
// Size / footprint estimation
// ---------------------------------------------------------------------------

export interface FootprintEstimate {
  /** Number of GFS slots the policy can occupy (daily + weekly + monthly). */
  slots: number;
  /** Average size of the recent backups used as the per-slot estimate. */
  averageBackupBytes: number;
  /** Projected steady-state disk usage of the retained scheduled backups. */
  steadyStateBytes: number;
  /** Free disk required before taking another backup (2x the newest backup). */
  requiredFreeBytes: number;
}

/**
 * Projects the retention policy's steady-state footprint from recent backup
 * sizes (newest first). With no history every estimate is 0 — the caller
 * should then fall back to its own minimum-free-disk threshold.
 */
export function estimateFootprint(
  retention: BackupRetentionPolicy,
  recentSizesNewestFirst: number[],
): FootprintEstimate {
  const slots = retention.daily + retention.weekly + retention.monthly;
  const sizes = recentSizesNewestFirst.filter((n) => Number.isFinite(n) && n >= 0);
  const average = sizes.length === 0 ? 0 : Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  const newest = sizes[0] ?? 0;
  return {
    slots,
    averageBackupBytes: average,
    steadyStateBytes: slots * average,
    requiredFreeBytes: 2 * (newest > 0 ? newest : average),
  };
}
