// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
//
// Scoped coverage gate (CI): the backup engine (schedule/retention/manifest/
// restore/clone) and the web scheduler loop must stay >=70% covered. Scoped on
// purpose so the gate cannot be tripped by legacy files it does not own.
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

const baseTest = base.test ?? {};

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: [
      'packages/backup/src/**/*.test.ts',
      'apps/web/src/backup-scheduler.test.ts',
      'apps/web/src/jobs.test.ts',
      'apps/cli/src/cli.test.ts',
    ],
    coverage: {
      provider: 'v8',
      enabled: true,
      include: ['packages/backup/src/**/*.ts', 'apps/web/src/backup-scheduler.ts'],
      exclude: ['**/index.ts', '**/*.test.ts'],
      // Report only modules the gate's tests actually load. On Windows the
      // "add uncovered files" pass globs with the opposite drive-letter case
      // (D:\ vs d:\) and would double-count every file as 0%-covered. The
      // suites above import every gated module, so nothing escapes the gate.
      all: false,
      thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
    },
  },
});
