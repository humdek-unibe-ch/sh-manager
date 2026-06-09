// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Mantine theme for the manager web UI.
 *
 * Kept intentionally close to the Mantine defaults (the same baseline the
 * SelfHelp frontend builds on) so the two UIs feel consistent and are
 * maintained the same way. Tweak tokens here rather than adding custom CSS.
 */
import { createTheme } from '@mantine/core';

export const theme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'md',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
});
