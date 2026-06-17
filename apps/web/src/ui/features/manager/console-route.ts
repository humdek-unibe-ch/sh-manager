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
 *   '/new-instance'   -> full-page create wizard
 *   '/instances/:id'  -> the instance workspace
 *
 * The create wizard deliberately lives at `/new-instance`, OUTSIDE the
 * `/instances/:id` space. It used to be `/instances/new`, which collided with
 * an instance whose id is literally `new`: opening that instance navigated to
 * `/instances/new`, the parser read it as the wizard, and the "Open instance"
 * button looked broken. Keeping the wizard off the instance namespace means
 * every valid instance id (including `new`) has its own reachable workspace.
 */
export interface ConsoleRoute {
  /** Selected instance id, or `null` for the dashboard / create wizard. */
  instanceId: string | null;
  /** Sub-view marker — `'new'` is the create wizard. */
  view: string | null;
}

/** Path of the dedicated full-page create-instance wizard. */
export const CREATE_INSTANCE_ROUTE = '/new-instance';

export function parseConsoleRoute(pathname: string): ConsoleRoute {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 1 && segments[0] === 'new-instance') {
    return { instanceId: null, view: 'new' };
  }
  if (segments[0] !== 'instances' || segments.length < 2) {
    return { instanceId: null, view: null };
  }
  return { instanceId: decodeURIComponent(segments[1]!), view: segments[2] ?? null };
}
