// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/** Pure formatting helpers for CLI output (kept side-effect free + testable). */
import type { HealthReport } from '@shm/core';
import type { UpdatePreflightResult } from '@shm/schemas';

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function formatPreflight(result: UpdatePreflightResult): string {
  const lines = [
    `Preflight ${result.instanceId}: ${result.currentVersion} -> ${result.targetVersion}  [${result.status.toUpperCase()}]`,
  ];
  for (const c of result.checks) {
    const mark = c.severity === 'error' ? 'x' : c.severity === 'warning' ? '!' : '.';
    lines.push(`  ${mark} [${c.code}] ${c.message}`);
  }
  if (result.options.length > 0) {
    lines.push('  Options:');
    for (const o of result.options) lines.push(`    - ${o.label}${o.version ? ` (${o.version})` : ''}`);
  }
  if (result.database.destructive) {
    lines.push('  ! Destructive migration: backup + manual confirmation required.');
  }
  return lines.join('\n');
}

export function formatHealth(report: HealthReport): string {
  const lines = [`Health ${report.instanceId}: ${report.overall.toUpperCase()} (${report.checkedAt})`];
  for (const s of report.services) {
    const mark = s.state === 'healthy' ? 'ok ' : s.state === 'degraded' ? '~  ' : 'DOWN';
    lines.push(`  ${mark} ${s.service}${s.detail ? ` - ${s.detail}` : ''}`);
  }
  return lines.join('\n');
}

/** Generic titled step list for plan-style output (remove/restore/clone). */
export function formatSteps(title: string, steps: string[]): string {
  return [title, ...steps.map((s) => `  - ${s}`)].join('\n');
}
