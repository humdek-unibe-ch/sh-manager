// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '../test/render';
import { usePagination } from './use-pagination';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe('usePagination', () => {
  it('slices items into pages and reports the visible range', () => {
    const { result } = renderHook(() => usePagination(range(60), 25));

    expect(result.current.pageCount).toBe(3);
    expect(result.current.total).toBe(60);
    expect(result.current.hasPages).toBe(true);
    expect(result.current.pageItems).toHaveLength(25);
    expect(result.current.pageItems[0]).toBe(1);
    expect(result.current.range).toEqual({ from: 1, to: 25 });
  });

  it('returns the requested page slice', () => {
    const { result } = renderHook(() => usePagination(range(60), 25));

    act(() => result.current.setPage(2));

    expect(result.current.page).toBe(2);
    expect(result.current.pageItems[0]).toBe(26);
    expect(result.current.pageItems.at(-1)).toBe(50);
    expect(result.current.range).toEqual({ from: 26, to: 50 });
  });

  it('does not paginate when everything fits on one page', () => {
    const { result } = renderHook(() => usePagination(range(5), 25));

    expect(result.current.hasPages).toBe(false);
    expect(result.current.pageCount).toBe(1);
    expect(result.current.pageItems).toHaveLength(5);
    expect(result.current.range).toEqual({ from: 1, to: 5 });
  });

  it('clamps the page when the data shrinks (delete / live refetch)', () => {
    const { result, rerender } = renderHook(({ items }) => usePagination(items, 25), {
      initialProps: { items: range(60) },
    });

    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);

    rerender({ items: range(10) });

    // The stale page index can't strand the user on an empty page.
    expect(result.current.page).toBe(1);
    expect(result.current.hasPages).toBe(false);
    expect(result.current.pageItems).toHaveLength(10);
  });

  it('handles an empty list', () => {
    const { result } = renderHook(() => usePagination([], 25));

    expect(result.current.total).toBe(0);
    expect(result.current.pageCount).toBe(1);
    expect(result.current.hasPages).toBe(false);
    expect(result.current.range).toEqual({ from: 0, to: 0 });
  });
});
