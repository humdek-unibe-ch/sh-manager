// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Global Vitest setup. Adds the jest-dom matchers (`toBeInTheDocument`, …) to
 * `expect`. Importing this in node-environment package tests is harmless: it
 * only extends the matcher table and never touches the DOM until a matcher runs.
 */
import '@testing-library/jest-dom/vitest';
