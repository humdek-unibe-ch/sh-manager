// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** Shared with vitest.coverage-gate.config.ts. */
export const baseConfig = {
  plugins: [react()],
  resolve: {
    alias: {
      '@shm/schemas': r('./packages/schemas/src/index.ts'),
      '@shm/registry': r('./packages/registry/src/index.ts'),
      '@shm/resolver': r('./packages/resolver/src/index.ts'),
      '@shm/docker': r('./packages/docker/src/index.ts'),
      '@shm/traefik': r('./packages/traefik/src/index.ts'),
      '@shm/instances': r('./packages/instances/src/index.ts'),
      '@shm/core': r('./packages/core/src/index.ts'),
      '@shm/backup': r('./packages/backup/src/index.ts'),
      '@shm/support': r('./packages/support/src/index.ts'),
      '@shm/auth': r('./packages/auth/src/index.ts'),
      '@shm/app-actions': r('./packages/app-actions/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./apps/web/src/ui/test/setup.ts'],
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx', 'e2e/**/*.test.ts'],
    // React/UI tests opt into jsdom with a `// @vitest-environment jsdom`
    // comment; everything else runs in node.
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts', 'apps/**/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.test.ts', 'apps/web/**'],
    },
  },
} satisfies ViteUserConfig;

export default defineConfig(baseConfig);
