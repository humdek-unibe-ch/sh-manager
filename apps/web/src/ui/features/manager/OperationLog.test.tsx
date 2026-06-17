// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Operation log viewer rendering + the errors-only log filter.
 *
 * The render test was split out of the original `InstanceManagement.test.tsx`
 * (renders through the shared Mantine-aware `../../test/render` and the
 * in-memory `../../test/fake-client`); the `isProblemLogLine` unit tests are the
 * original `OperationLog.test.tsx` cases. The test bodies are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '../../test/render';
import { OperationLog, isProblemLogLine } from './OperationLog';
import { makeFakeClient, fakeOperation } from '../../test/fake-client';

describe('OperationLog', () => {
  it('renders the journaled log lines and the failure message', async () => {
    const client = makeFakeClient({
      operations: [
        fakeOperation({
          id: 'op-fail',
          kind: 'instance_update',
          status: 'failed',
          log: ['backup: ok', 'migrate: error'],
          error: 'Migration Version123 failed; instance rolled back.',
          result: null,
        }),
      ],
    });
    render(<OperationLog client={client} operationId="op-fail" />);

    expect(await screen.findByText(/backup: ok/)).toBeInTheDocument();
    expect(screen.getByText(/migrate: error/)).toBeInTheDocument();
    expect(screen.getByText('Operation failed')).toBeInTheDocument();
    expect(screen.getByText(/rolled back/i)).toBeInTheDocument();
    // The per-kind step checklist renders alongside the raw log.
    expect(screen.getByText('Resolve & plan update')).toBeInTheDocument();
    expect(screen.getByText('Run database migrations')).toBeInTheDocument();
  });
});

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
