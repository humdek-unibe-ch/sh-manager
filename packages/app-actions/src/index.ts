// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * `@shm/app-actions` — the shared application-service layer used by BOTH apps
 * (`apps/cli` and `apps/web`). It is the orchestration tier that sits on top of
 * the pure domain packages (`@shm/core`, `@shm/docker`, `@shm/instances`,
 * `@shm/backup`, `@shm/registry`, `@shm/support`): server bootstrap, instance
 * install/update/backup/restore/lifecycle, operation draining and the
 * diagnostic/recovery actions, plus the real side-effecting `ActionDeps`
 * wiring, the self-update flow and the Docker/HTTP backend clients.
 *
 * Boundary rule: this package contains NO CLI prompts/formatting, NO React, and
 * NO HTTP-server route handling. Those adapters live in `apps/cli` / `apps/web`.
 * Keep it split by domain (`actions/<area>`, the clients, `env`, `self-update`);
 * do not let it grow back into a single monolith.
 */
export * from './actions.js';
export * from './env.js';
export * from './self-update.js';
export * from './operations-client.js';
export * from './plugin-state-client.js';
