// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Schedule-engine tests. All Dates are constructed from LOCAL components (or
 * local ISO strings without a zone suffix) so the assertions hold in any host
 * time zone — the engine itself is defined over server-local time.
 */
import { describe, expect, it } from 'vitest';
import type { BackupSchedulePolicy } from '@shm/schemas';
import {
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_BACKUP_SCHEDULE,
  isBackupDue,
  lastScheduledOccurrence,
  nextRunAt,
  parseScheduleTime,
  validateSchedulePolicy,
} from './schedule.js';

const policy = (overrides: Partial<BackupSchedulePolicy> = {}): BackupSchedulePolicy => ({
  enabled: true,
  time: '02:00',
  retention: { ...DEFAULT_BACKUP_RETENTION },
  ...overrides,
});

const local = (y: number, m1: number, d: number, hh = 0, mm = 0): Date => new Date(y, m1 - 1, d, hh, mm, 0, 0);

describe('validateSchedulePolicy', () => {
  it('accepts the defaults', () => {
    expect(validateSchedulePolicy({ ...DEFAULT_BACKUP_SCHEDULE })).toEqual([]);
    expect(validateSchedulePolicy(policy())).toEqual([]);
  });

  it('rejects malformed times', () => {
    for (const time of ['24:00', '2:00', '02:60', '0200', 'midnight', '']) {
      const problems = validateSchedulePolicy(policy({ time }));
      expect(problems.join(' ')).toMatch(/HH:MM/);
    }
  });

  it('rejects out-of-range or non-integer retention values', () => {
    const bad = policy({ retention: { daily: 0, weekly: -1, monthly: 2.5, maxAgeDays: 1 } });
    const problems = validateSchedulePolicy(bad);
    expect(problems.some((p) => p.includes('retention.daily'))).toBe(true);
    expect(problems.some((p) => p.includes('retention.weekly'))).toBe(true);
    expect(problems.some((p) => p.includes('retention.monthly'))).toBe(true);
    expect(problems.some((p) => p.includes('retention.maxAgeDays'))).toBe(true);
  });

  it('parseScheduleTime throws on garbage and parses valid times', () => {
    expect(parseScheduleTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(() => parseScheduleTime('25:00')).toThrow(/Invalid schedule time/);
  });
});

describe('lastScheduledOccurrence', () => {
  it('is today when the configured time has passed', () => {
    const occ = lastScheduledOccurrence({ time: '02:00' }, local(2026, 6, 12, 14, 0));
    expect(occ).toEqual(local(2026, 6, 12, 2, 0));
  });

  it('is yesterday when the configured time has not been reached yet', () => {
    const occ = lastScheduledOccurrence({ time: '02:00' }, local(2026, 6, 12, 1, 30));
    expect(occ).toEqual(local(2026, 6, 11, 2, 0));
  });

  it('counts the exact configured minute as already occurred', () => {
    const occ = lastScheduledOccurrence({ time: '02:00' }, local(2026, 6, 12, 2, 0));
    expect(occ).toEqual(local(2026, 6, 12, 2, 0));
  });
});

describe('isBackupDue', () => {
  it('is never due when disabled', () => {
    expect(isBackupDue(policy({ enabled: false }), null, local(2026, 6, 12, 3, 0))).toBe(false);
  });

  it('is due on the first ever tick after the occurrence (no previous run)', () => {
    expect(isBackupDue(policy(), null, local(2026, 6, 12, 2, 1))).toBe(true);
  });

  it('is not due before the daily time when yesterday was covered', () => {
    const lastRun = local(2026, 6, 11, 2, 0);
    expect(isBackupDue(policy(), lastRun, local(2026, 6, 12, 1, 59))).toBe(false);
  });

  it('becomes due after the daily time and stops being due once run', () => {
    const lastRun = local(2026, 6, 11, 2, 0);
    expect(isBackupDue(policy(), lastRun, local(2026, 6, 12, 2, 0))).toBe(true);
    const ranNow = local(2026, 6, 12, 2, 5);
    expect(isBackupDue(policy(), ranNow, local(2026, 6, 12, 23, 0))).toBe(false);
  });

  it('catches up exactly once after manager downtime (no storm)', () => {
    // Manager down for a week: the missed occurrences collapse into one run.
    const lastRun = local(2026, 6, 5, 2, 0);
    const now = local(2026, 6, 12, 9, 0);
    expect(isBackupDue(policy(), lastRun, now)).toBe(true);
    // After that single catch-up run, nothing further is due today.
    expect(isBackupDue(policy(), now, local(2026, 6, 12, 23, 59))).toBe(false);
    // The regular schedule resumes tomorrow.
    expect(isBackupDue(policy(), now, local(2026, 6, 13, 2, 0))).toBe(true);
  });
});

describe('nextRunAt', () => {
  it('is null when disabled', () => {
    expect(nextRunAt(policy({ enabled: false }), null, local(2026, 6, 12))).toBeNull();
  });

  it('is now when a run is already due', () => {
    const now = local(2026, 6, 12, 5, 0);
    expect(nextRunAt(policy(), null, now)).toEqual(now);
  });

  it('is the next occurrence when up to date', () => {
    const now = local(2026, 6, 12, 5, 0);
    const next = nextRunAt(policy(), now, now);
    expect(next).toEqual(local(2026, 6, 13, 2, 0));
  });

  it('crosses month boundaries on the local calendar', () => {
    const now = local(2026, 1, 31, 5, 0);
    expect(nextRunAt(policy(), now, now)).toEqual(local(2026, 2, 1, 2, 0));
  });

  it('crosses year boundaries on the local calendar', () => {
    const now = local(2026, 12, 31, 5, 0);
    expect(nextRunAt(policy(), now, now)).toEqual(local(2027, 1, 1, 2, 0));
  });
});
