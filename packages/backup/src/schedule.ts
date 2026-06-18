// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Pure scheduling logic for nightly instance backups.
 *
 * All functions are deterministic over their `now` argument (no global clock,
 * no IO) so they are unit-testable with plain Dates. Times are interpreted in
 * the manager server's LOCAL time zone — that is what operators reason in when
 * they configure "back up at 02:00" — and occurrences are computed via local
 * calendar components so a DST shift never skips or doubles a run.
 *
 * Catch-up semantics: a run is "due" when the most recent scheduled occurrence
 * has not been covered by a successful run yet. A manager that was down for a
 * week therefore takes exactly ONE catch-up backup when it comes back, never a
 * storm of seven.
 */
import type { BackupRetentionPolicy, BackupSchedulePolicy } from '@shm/schemas';

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  daily: 7,
  weekly: 5,
  monthly: 12,
  maxAgeDays: 365,
};

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedulePolicy = {
  enabled: false,
  time: '02:00',
  retention: DEFAULT_BACKUP_RETENTION,
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseScheduleTime(time: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid schedule time "${time}" (expected HH:MM, 24h).`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Validates a schedule policy as it arrives from the CLI/BFF boundary.
 * Returns human-readable problems; an empty array means valid.
 */
export function validateSchedulePolicy(policy: BackupSchedulePolicy): string[] {
  const problems: string[] = [];
  if (typeof policy.enabled !== 'boolean') problems.push('enabled must be a boolean.');
  if (typeof policy.time !== 'string' || !TIME_RE.test(policy.time)) {
    problems.push(`time must be HH:MM (24h), got "${policy.time}".`);
  }
  const r = policy.retention;
  if (!r || typeof r !== 'object') {
    problems.push('retention is required.');
    return problems;
  }
  const intIn = (name: string, value: unknown, min: number, max: number): void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`retention.${name} must be an integer between ${min} and ${max}.`);
    }
  };
  intIn('daily', r.daily, 1, 90);
  intIn('weekly', r.weekly, 0, 52);
  intIn('monthly', r.monthly, 0, 60);
  intIn('maxAgeDays', r.maxAgeDays, 7, 3650);
  return problems;
}

/**
 * The most recent scheduled occurrence at or before `now`, in local time.
 * (Today's HH:MM when that has passed, otherwise yesterday's.)
 */
export function lastScheduledOccurrence(policy: Pick<BackupSchedulePolicy, 'time'>, now: Date): Date {
  const { hour, minute } = parseScheduleTime(policy.time);
  const occurrence = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (occurrence.getTime() > now.getTime()) occurrence.setDate(occurrence.getDate() - 1);
  return occurrence;
}

/**
 * Is a scheduled backup due right now? True when the policy is enabled and no
 * run has covered the most recent occurrence (including after downtime).
 */
export function isBackupDue(policy: BackupSchedulePolicy, lastRunAt: Date | null, now: Date): boolean {
  if (!policy.enabled) return false;
  const occurrence = lastScheduledOccurrence(policy, now);
  return lastRunAt === null || lastRunAt.getTime() < occurrence.getTime();
}

/**
 * When the next backup will run: `now` when one is already due (catch-up),
 * otherwise the next HH:MM occurrence strictly after `now`.
 */
export function nextRunAt(policy: BackupSchedulePolicy, lastRunAt: Date | null, now: Date): Date | null {
  if (!policy.enabled) return null;
  if (isBackupDue(policy, lastRunAt, now)) return new Date(now.getTime());
  const next = lastScheduledOccurrence(policy, now);
  // Local-calendar day increment (DST-safe: HH:MM stays the configured time).
  next.setDate(next.getDate() + 1);
  return next;
}
