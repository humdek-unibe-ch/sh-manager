// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Public surface of the CLI action layer.
 *
 * All side effects (Docker, registry fetch, resource probing, health probing,
 * image-digest resolution) are injected via {@link ActionDeps} so the offline
 * paths are unit-testable and the real wiring lives in env.ts. The actions are
 * split by domain into sibling modules; this barrel re-exports the exact same
 * public symbols the CLI, the web BFF and the e2e harness import by name. The
 * cross-cutting helpers in `shared.ts` stay internal — only the genuinely
 * public symbols that happen to live there are re-exported below.
 */
export type { ActionDeps, OperationProgress, PluginDrainOverrides } from './shared.js';
export { ADMIN_PASSWORD_FILENAME, ensureProxyRunning } from './shared.js';
export * from './bootstrap.js';
export * from './install.js';
export * from './update.js';
export * from './operations.js';
export * from './backup.js';
export * from './restore.js';
export * from './lifecycle.js';
export * from './support.js';
