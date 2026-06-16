// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Tiny client-side pagination helper for the manager's growable tables
 * (operation history, backups, instances). Keeps long lists navigable without
 * pulling in a data-grid: it slices an in-memory array into pages and exposes
 * the bits a Mantine `<Pagination>` footer needs.
 *
 * The page auto-clamps when the underlying data shrinks (a delete or a live SSE
 * refetch) so the operator is never stranded on an empty page.
 */
import { useEffect, useMemo, useState } from 'react';

export interface UsePaginationResult<T> {
  /** Current 1-based page. */
  page: number;
  setPage: (page: number) => void;
  /** Total number of pages (>= 1). */
  pageCount: number;
  /** Items for the current page only. */
  pageItems: T[];
  /** Total item count across all pages. */
  total: number;
  pageSize: number;
  /** True when there is more than one page (render the control). */
  hasPages: boolean;
  /** 1-based inclusive range shown on this page, for an "x–y of n" caption. */
  range: { from: number; to: number };
}

export function usePagination<T>(items: T[], pageSize = 25): UsePaginationResult<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const [page, setPage] = useState(1);

  // Clamp when the data shrinks so a stale page index can't strand the user.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageItems = useMemo(() => items.slice(start, start + pageSize), [items, start, pageSize]);

  return {
    page: safePage,
    setPage,
    pageCount,
    pageItems,
    total,
    pageSize,
    hasPages: pageCount > 1,
    range: { from: total === 0 ? 0 : start + 1, to: Math.min(start + pageSize, total) },
  };
}
