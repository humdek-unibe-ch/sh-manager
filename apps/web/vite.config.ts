// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// The localhost BFF the SPA talks to during `vite dev` (the Node manager server).
const apiTarget = process.env.SHM_WEB_API ?? 'http://127.0.0.1:8765';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shm/schemas': r('../../packages/schemas/src/index.ts'),
      '@shm/registry': r('../../packages/registry/src/index.ts'),
      '@shm/resolver': r('../../packages/resolver/src/index.ts'),
      '@shm/docker': r('../../packages/docker/src/index.ts'),
      '@shm/traefik': r('../../packages/traefik/src/index.ts'),
      '@shm/instances': r('../../packages/instances/src/index.ts'),
      '@shm/core': r('../../packages/core/src/index.ts'),
      '@shm/backup': r('../../packages/backup/src/index.ts'),
      '@shm/support': r('../../packages/support/src/index.ts'),
      '@shm/auth': r('../../packages/auth/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
});
