// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Console route parsing.
 *
 * The operations console is a single mounted shell (so cross-navigation state
 * such as a watched install survives moving between the dashboard and an
 * instance). It therefore intentionally does NOT mount `<Routes>`/`<Route>`
 * elements — which means `useParams()` has no matched route to read from and
 * always returns `{}`. Instead the shell derives its view state from the raw
 * pathname via this pure helper, which keeps the logic deterministic and
 * unit-testable without a DOM.
 *
 * Recognised shapes:
 *   '/'               -> dashboard
 *   '/instances/new'  -> full-page create wizard
 *   '/instances/:id'  -> the instance workspace
 */
export interface ConsoleRoute {
  /** Selected instance id, or `null` for the dashboard / create wizard. */
  instanceId: string | null;
  /** Sub-view marker — currently only `'new'` (the create wizard). */
  view: string | null;
}

export function parseConsoleRoute(pathname: string): ConsoleRoute {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'instances' || segments.length < 2) {
    return { instanceId: null, view: null };
  }
  if (segments[1] === 'new') {
    return { instanceId: null, view: 'new' };
  }
  return { instanceId: decodeURIComponent(segments[1]!), view: segments[2] ?? null };
}
