// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Stable entry point for the CLI action layer.
 *
 * The actions are split by domain under `./actions/` (bootstrap, install,
 * update, operations, backup, restore, lifecycle, support) behind a shared
 * internals module. This file is a behaviour-preserving barrel so every
 * existing import (`./actions.js`, `../../cli/src/actions.js`) keeps working
 * unchanged.
 */
export * from './actions/index.js';
