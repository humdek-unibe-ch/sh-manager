// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * CLI output formatting (tables, health report, preflight, steps).
 *
 * Split out of the original monolithic `cli.test.ts`; the shared offline
 * {@link ActionDeps} builder + fixtures live in `cli-test-support`. The test
 * bodies are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { formatHealth, formatPreflight, formatTable } from './output.js';

describe('output formatting', () => {
  it('formats a table', () => {
    const t = formatTable(['A', 'B'], [['1', '22'], ['333', '4']]);
    expect(t.split('\n')).toHaveLength(4);
  });
  it('formats preflight + health', () => {
    expect(formatPreflight({
      preflightVersion: 1, status: 'ok', instanceId: 'x', currentVersion: '1', targetVersion: '2',
      checks: [{ code: 'c', severity: 'info', message: 'm' }], options: [],
      database: { destructive: false, requiresBackup: true, manualConfirmationRequired: false },
      rollback: { automaticBeforeMigrations: true, automaticAfterDestructiveMigrations: false },
    })).toContain('[OK]');
    expect(formatHealth({ instanceId: 'x', overall: 'healthy', services: [{ service: 'backend', state: 'healthy', required: true }], checkedAt: 'now' })).toContain('HEALTHY');
  });
});
