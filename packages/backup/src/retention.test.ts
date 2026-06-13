// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * GFS retention tests, including the safety invariants the pruner must never
 * violate (these are security regressions: a wrong deletion destroys the only
 * recovery point of a production instance).
 *
 * Dates use LOCAL ISO strings (no zone suffix) so day/weekday math matches the
 * engine's local-calendar semantics in any host time zone. Anchors: in June
 * 2026, the 1st and the 8th are Mondays; "now" is Friday 2026-06-12.
 */
import { describe, expect, it } from 'vitest';
import type { BackupOrigin, BackupRetentionPolicy } from '@shm/schemas';
import { estimateFootprint, planPrune, type BackupCandidate } from './retention.js';

const NOW = new Date(2026, 5, 12, 12, 0, 0); // 2026-06-12 12:00 local

const RETENTION: BackupRetentionPolicy = { daily: 7, weekly: 5, monthly: 12, maxAgeDays: 365 };

let seq = 0;
function cand(createdAtLocalIso: string, origin: BackupOrigin = 'scheduled'): BackupCandidate {
  seq += 1;
  return { backupId: `backup-${seq.toString().padStart(3, '0')}`, createdAt: createdAtLocalIso, origin };
}

function decisionsOf(plan: ReturnType<typeof planPrune>, id: string) {
  return [...plan.keep, ...plan.prune].find((d) => d.backupId === id)!;
}

describe('planPrune — safety invariants (security regressions)', () => {
  it('never prunes manual backups, no matter how old', () => {
    const ancientManual = cand('2020-01-01T02:00:00', 'manual');
    const plan = planPrune([ancientManual], RETENTION, NOW);
    expect(plan.prune).toHaveLength(0);
    expect(plan.keep[0]!.reasons).toEqual(['manual']);
  });

  it('never prunes the newest scheduled backup, even past max age', () => {
    const onlyScheduled = cand('2024-01-01T02:00:00'); // ~2.5 years old
    const plan = planPrune([onlyScheduled], RETENTION, NOW);
    expect(plan.prune).toHaveLength(0);
    expect(plan.keep[0]!.reasons).toContain('newest-scheduled');
  });

  it('keeps safety backups within max age and prunes them beyond it', () => {
    const recentPreUpdate = cand('2026-06-01T10:00:00', 'pre_update');
    const oldPreRestore = cand('2025-01-01T10:00:00', 'pre_restore'); // > 365 days
    const plan = planPrune([recentPreUpdate, oldPreRestore], RETENTION, NOW);
    expect(decisionsOf(plan, recentPreUpdate.backupId).action).toBe('keep');
    expect(decisionsOf(plan, recentPreUpdate.backupId).reasons).toEqual(['safety-within-max-age']);
    expect(decisionsOf(plan, oldPreRestore.backupId).action).toBe('prune');
    expect(decisionsOf(plan, oldPreRestore.backupId).reasons).toEqual(['older-than-max-age']);
  });

  it('classifies every candidate exactly once (keep + prune are exhaustive)', () => {
    const candidates: BackupCandidate[] = [];
    for (let day = 1; day <= 12; day++) {
      candidates.push(cand(`2026-06-${String(day).padStart(2, '0')}T02:00:00`));
    }
    candidates.push(cand('2026-06-10T15:00:00', 'manual'), cand('2026-06-11T09:00:00', 'pre_update'));
    const plan = planPrune(candidates, RETENTION, NOW);
    const all = [...plan.keep, ...plan.prune].map((d) => d.backupId).sort();
    expect(all).toEqual(candidates.map((c) => c.backupId).sort());
  });

  it('the max-age hard cap overrides slot membership (except newest-scheduled)', () => {
    // 2025-06-01 was a 1st-of-month: a monthly candidate, but 376 days old.
    const tooOldMonthly = cand('2025-06-01T02:00:00');
    const newest = cand('2026-06-12T02:00:00');
    const generous: BackupRetentionPolicy = { ...RETENTION, monthly: 24 };
    const plan = planPrune([tooOldMonthly, newest], generous, NOW);
    expect(decisionsOf(plan, tooOldMonthly.backupId).action).toBe('prune');
    expect(decisionsOf(plan, tooOldMonthly.backupId).reasons).toEqual(['older-than-max-age']);
    expect(decisionsOf(plan, newest.backupId).action).toBe('keep');
  });
});

describe('planPrune — GFS slots', () => {
  it('keeps the last N distinct days as dailies and prunes older non-slot days', () => {
    // 12 consecutive nightly backups; daily=7, no weekly/monthly slots.
    const retention: BackupRetentionPolicy = { daily: 7, weekly: 0, monthly: 0, maxAgeDays: 365 };
    const candidates = Array.from({ length: 12 }, (_, i) =>
      cand(`2026-06-${String(i + 1).padStart(2, '0')}T02:00:00`),
    );
    const plan = planPrune(candidates, retention, NOW);
    // Days 6..12 (7 most recent distinct days) stay; 1..5 prune.
    expect(plan.keep.filter((d) => d.reasons.includes('daily'))).toHaveLength(7);
    expect(plan.prune).toHaveLength(5);
    for (const p of plan.prune) expect(p.reasons).toEqual(['beyond-retention']);
  });

  it('keeps every backup of a day inside the daily window (same-day duplicates)', () => {
    const retention: BackupRetentionPolicy = { daily: 2, weekly: 0, monthly: 0, maxAgeDays: 365 };
    const a = cand('2026-06-12T02:00:00');
    const b = cand('2026-06-12T14:00:00'); // second backup the same day
    const c = cand('2026-06-11T02:00:00');
    const plan = planPrune([a, b, c], retention, NOW);
    expect(plan.prune).toHaveLength(0);
    expect(decisionsOf(plan, a.backupId).reasons).toContain('daily');
    expect(decisionsOf(plan, b.backupId).reasons).toContain('daily');
  });

  it('keeps the newest backup of the most recent N Mondays as weeklies', () => {
    const retention: BackupRetentionPolicy = { daily: 1, weekly: 5, monthly: 0, maxAgeDays: 365 };
    // Mondays: Jun 8, Jun 1, May 25, May 18, May 11, May 4 (newest -> oldest).
    const mondays = ['2026-06-08', '2026-06-01', '2026-05-25', '2026-05-18', '2026-05-11', '2026-05-04'];
    const candidates = mondays.map((d) => cand(`${d}T02:00:00`));
    const plan = planPrune(candidates, retention, NOW);
    const kept = plan.keep.filter((d) => d.reasons.includes('weekly')).map((d) => d.createdAt.slice(0, 10));
    expect(kept).toEqual(['2026-06-08', '2026-06-01', '2026-05-25', '2026-05-18', '2026-05-11']);
    // The 6th Monday falls out of the weekly window.
    expect(decisionsOf(plan, candidates[5]!.backupId).action).toBe('prune');
  });

  it('keeps the newest backup of the most recent N 1st-of-month days as monthlies', () => {
    const retention: BackupRetentionPolicy = { daily: 1, weekly: 0, monthly: 3, maxAgeDays: 365 };
    const firsts = ['2026-06-01', '2026-05-01', '2026-04-01', '2026-03-01'];
    const candidates = firsts.map((d) => cand(`${d}T02:00:00`));
    const plan = planPrune(candidates, retention, NOW);
    const kept = plan.keep.filter((d) => d.reasons.includes('monthly')).map((d) => d.createdAt.slice(0, 10));
    expect(kept).toEqual(['2026-06-01', '2026-05-01', '2026-04-01']);
    expect(decisionsOf(plan, candidates[3]!.backupId).action).toBe('prune');
  });

  it('a backup on a Monday that is also the 1st serves both roles, monthly first', () => {
    // 2026-06-01 is both a Monday and the 1st of the month.
    const retention: BackupRetentionPolicy = { daily: 1, weekly: 5, monthly: 12, maxAgeDays: 365 };
    const overlap = cand('2026-06-01T02:00:00');
    const plan = planPrune([overlap], retention, NOW);
    const d = decisionsOf(plan, overlap.backupId);
    expect(d.action).toBe('keep');
    expect(d.reasons).toContain('monthly');
    expect(d.reasons).toContain('weekly');
    // Monthly wins the display order over weekly/daily.
    const slotReasons = d.reasons.filter((r) => r === 'monthly' || r === 'weekly' || r === 'daily');
    expect(slotReasons[0]).toBe('monthly');
  });

  it('a realistic year of nightly backups converges to dailies + Mondays + 1sts', () => {
    // Nightly backups since mid-June 2025 (one per day at 02:00).
    const candidates: BackupCandidate[] = [];
    for (let t = new Date(2025, 5, 15, 2, 0, 0); t <= NOW; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 2, 0, 0)) {
      const p = (n: number) => String(n).padStart(2, '0');
      candidates.push(cand(`${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T02:00:00`));
    }
    const plan = planPrune(candidates, RETENTION, NOW);

    const keptDays = plan.keep.map((d) => d.createdAt.slice(0, 10));
    // 7 dailies: Jun 6..12 2026.
    for (const day of ['2026-06-06', '2026-06-12']) expect(keptDays).toContain(day);
    // 5 weekly Mondays: Jun 8, Jun 1, May 25, May 18, May 11.
    for (const day of ['2026-06-08', '2026-05-25', '2026-05-11']) expect(keptDays).toContain(day);
    // 12 monthly 1sts back to July 2025 (within max age).
    for (const day of ['2026-06-01', '2026-01-01', '2025-07-01']) expect(keptDays).toContain(day);

    // Total retained slots stay bounded (no runaway growth): 7 dailies +
    // Mondays + 1sts, minus overlaps — comfortably under the 24-slot ceiling.
    expect(plan.keep.length).toBeLessThanOrEqual(RETENTION.daily + RETENTION.weekly + RETENTION.monthly);
    expect(plan.keep.length).toBeGreaterThanOrEqual(20);
    // Everything else from ~363 nightly backups is pruned.
    expect(plan.prune.length).toBe(candidates.length - plan.keep.length);
    // And no pruned id is also kept (no double classification).
    const keptIds = new Set(plan.keep.map((d) => d.backupId));
    for (const p of plan.prune) expect(keptIds.has(p.backupId)).toBe(false);
  });
});

describe('estimateFootprint', () => {
  it('projects slots x average and 2x-newest required free space', () => {
    const est = estimateFootprint(RETENTION, [100, 200, 300]);
    expect(est.slots).toBe(24);
    expect(est.averageBackupBytes).toBe(200);
    expect(est.steadyStateBytes).toBe(24 * 200);
    expect(est.requiredFreeBytes).toBe(200); // 2 x newest (100)
  });

  it('returns zeros with no history and ignores invalid sizes', () => {
    expect(estimateFootprint(RETENTION, []).steadyStateBytes).toBe(0);
    expect(estimateFootprint(RETENTION, [Number.NaN, -5]).steadyStateBytes).toBe(0);
  });
});
