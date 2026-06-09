// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Stack, Text } from '@mantine/core';

export interface EmptyStateProps {
  icon?: string;
  title: string;
  children?: ReactNode;
}

export function EmptyState({ icon = '◦', title, children }: EmptyStateProps): JSX.Element {
  return (
    <Stack align="center" gap="xs" py="md">
      <Text fz={32} aria-hidden="true">
        {icon}
      </Text>
      <Text fw={600}>{title}</Text>
      {children ? (
        <Text c="dimmed" ta="center" size="sm">
          {children}
        </Text>
      ) : null}
    </Stack>
  );
}
