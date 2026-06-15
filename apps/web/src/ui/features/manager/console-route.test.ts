// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from 'vitest';
import { parseConsoleRoute } from './console-route';

describe('parseConsoleRoute', () => {
  it('treats the root as the dashboard', () => {
    expect(parseConsoleRoute('/')).toEqual({ instanceId: null, view: null });
    expect(parseConsoleRoute('')).toEqual({ instanceId: null, view: null });
  });

  it('maps /instances/new to the create wizard (no instance selected)', () => {
    expect(parseConsoleRoute('/instances/new')).toEqual({ instanceId: null, view: 'new' });
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
