// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Group, Pagination, Text } from '@mantine/core';

export interface PaginationFooterProps {
  /** Current 1-based page. */
  page: number;
  /** Total number of pages. */
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Total item count across all pages. */
  total: number;
  /** 1-based inclusive range shown on the current page. */
  range: { from: number; to: number };
  /** What the rows represent, for the caption (e.g. "operations"). */
  noun?: string;
}

/**
 * Shared footer for the manager's paginated tables: an "x–y of n" caption plus
 * a Mantine pagination control. Renders nothing when everything fits on one
 * page, so callers can drop it under any table unconditionally.
 */
export function PaginationFooter({
  page,
  pageCount,
  onPageChange,
  total,
  range,
  noun = 'items',
}: PaginationFooterProps): JSX.Element | null {
  if (pageCount <= 1) return null;
  return (
    <Group justify="space-between" align="center" mt="sm" wrap="wrap">
      <Text size="xs" c="dimmed">
        Showing {range.from}–{range.to} of {total} {noun}
      </Text>
      <Pagination value={page} onChange={onPageChange} total={pageCount} size="sm" withEdges />
    </Group>
  );
}
