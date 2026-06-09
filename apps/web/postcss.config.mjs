/*
SPDX-FileCopyrightText: 2026 Humdek, University of Bern
SPDX-License-Identifier: MPL-2.0
*/
// Tailwind CSS 4 runs as a PostCSS plugin, the same way the SelfHelp frontend
// (`sh-selfhelp_frontend`) wires it, so the two UIs share one styling toolchain.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
