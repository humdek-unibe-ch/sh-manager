// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Group, Stack, Text } from '@mantine/core';

export interface KeyValueRow {
  key: string;
  value: ReactNode;
  mono?: boolean;
}

export interface KeyValueProps {
  rows: KeyValueRow[];
}

/** A compact definition list for review/summary panels. */
export function KeyValue({ rows }: KeyValueProps): JSX.Element {
  return (
    <Stack gap={6}>
      {rows.map((row) => (
        <Group key={row.key} justify="space-between" align="flex-start" wrap="nowrap" gap="md">
          <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
            {row.key}
          </Text>
          <Text
            size="sm"
            ta="right"
            ff={row.mono ? 'monospace' : undefined}
            style={{ wordBreak: 'break-all' }}
          >
            {row.value}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
