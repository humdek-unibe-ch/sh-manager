// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from 'vitest';
import { isProblemLogLine } from './OperationLog';

describe('isProblemLogLine (errors-only log filter)', () => {
  it('keeps lines that report a problem', () => {
    const problems = [
      '[2026-06-16T08:40:21.066Z] health: failed — overall=unhealthy',
      '[2026-06-16T08:40:21.066Z] warning: DNS does not resolve to this server',
      '[2026-06-16T08:40:21.066Z] Operation #12 rejected (blocked): destructive migration',
      '[2026-06-16T08:40:21.066Z] --- rollback ---',
      '[2026-06-16T08:40:21.066Z] Plugin install sh-shp-survey-js failed: composer error',
      '[2026-06-16T08:40:21.066Z] interrupted by manager restart',
    ];
    for (const line of problems) expect(isProblemLogLine(line)).toBe(true);
  });

  it('drops ordinary progress lines', () => {
    const clean = [
      '[2026-06-16T08:40:21.066Z] --- backup ---',
      '[2026-06-16T08:40:21.066Z] pull: done',
      '[2026-06-16T08:40:21.066Z] Backup backup-1 written to /opt/selfhelp/...',
      '[2026-06-16T08:40:21.066Z] plan: create new isolated instance "sss"',
      '[2026-06-16T08:40:21.066Z] health: done — healthy',
    ];
    for (const line of clean) expect(isProblemLogLine(line)).toBe(false);
  });
});
