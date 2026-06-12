// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { stripRedundantManagerToken } from './argv.js';

describe('stripRedundantManagerToken', () => {
  it('drops a redundant leading sh-manager token (the wrapper paste case)', () => {
    expect(stripRedundantManagerToken(['node', 'bin.js', 'sh-manager', 'instance', 'health', 'x'])).toEqual([
      'node',
      'bin.js',
      'instance',
      'health',
      'x',
    ]);
  });

  it('leaves a normal invocation untouched', () => {
    const argv = ['node', 'bin.js', 'instance', 'list'];
    expect(stripRedundantManagerToken(argv)).toBe(argv);
  });

  it('only considers the first user token, never positional values', () => {
    const argv = ['node', 'bin.js', 'instance', 'health', 'sh-manager'];
    expect(stripRedundantManagerToken(argv)).toBe(argv);
  });

  it('handles bare argv (no user args) without changes', () => {
    const argv = ['node', 'bin.js'];
    expect(stripRedundantManagerToken(argv)).toBe(argv);
  });
});
