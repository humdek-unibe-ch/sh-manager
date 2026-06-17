// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from 'vitest';
import { parseConsoleRoute, CREATE_INSTANCE_ROUTE } from './console-route';

describe('parseConsoleRoute', () => {
  it('treats the root as the dashboard', () => {
    expect(parseConsoleRoute('/')).toEqual({ instanceId: null, view: null });
    expect(parseConsoleRoute('')).toEqual({ instanceId: null, view: null });
  });

  it('maps /new-instance to the create wizard (no instance selected)', () => {
    expect(parseConsoleRoute(CREATE_INSTANCE_ROUTE)).toEqual({ instanceId: null, view: 'new' });
    expect(parseConsoleRoute('/new-instance')).toEqual({ instanceId: null, view: 'new' });
  });

  it('opens an instance literally named "new" instead of the wizard (regression)', () => {
    // /instances/new used to be the wizard route, so an instance called "new"
    // was unreachable and its "Open instance" button was a no-op.
    expect(parseConsoleRoute('/instances/new')).toEqual({ instanceId: 'new', view: null });
  });

  it('selects an instance by id', () => {
    expect(parseConsoleRoute('/instances/clinic-a')).toEqual({
      instanceId: 'clinic-a',
      view: null,
    });
  });

  it('decodes an encoded instance id', () => {
    expect(parseConsoleRoute('/instances/clinic%20a')).toEqual({
      instanceId: 'clinic a',
      view: null,
    });
  });

  it('ignores an unrelated path (falls back to the dashboard)', () => {
    expect(parseConsoleRoute('/something-else')).toEqual({ instanceId: null, view: null });
  });

  it('exposes a per-instance sub-view segment', () => {
    expect(parseConsoleRoute('/instances/clinic-a/health')).toEqual({
      instanceId: 'clinic-a',
      view: 'health',
    });
  });
});
