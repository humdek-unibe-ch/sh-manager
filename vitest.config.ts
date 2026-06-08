// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
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
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./apps/web/src/ui/test/setup.ts'],
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    // React component tests run under jsdom; everything else stays in node.
    // Glob must tolerate absolute (incl. Windows) paths, so prefix with **/.
    environmentMatchGlobs: [['**/apps/web/src/ui/**', 'jsdom']],
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts', 'apps/**/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.test.ts', 'apps/web/**'],
    },
  },
});
