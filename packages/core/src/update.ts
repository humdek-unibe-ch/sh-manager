// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Update planning + execution, split by concern behind this stable barrel:
 * `plan` (core dry-run), `execute` (core update), `frontend` (frontend-only
 * update), `mysql` (runtime images + major-upgrade gate) and the shared step
 * plumbing. Importers keep using `@shm/core` / `./update.js` unchanged.
 */
export * from './update/shared.js';
export * from './update/plan.js';
export * from './update/mysql.js';
export * from './update/execute.js';
export * from './update/frontend.js';
