// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Card as MantineCard, Group, Text } from '@mantine/core';

export interface CardProps {
  title?: string;
  description?: string;
  /** Rendered top-right of the header (badge, action…). */
  aside?: ReactNode;
  raised?: boolean;
  children?: ReactNode;
}

export function Card({ title, description, aside, raised, children }: CardProps): JSX.Element {
  return (
    <MantineCard withBorder radius="md" padding="lg" shadow={raised ? 'sm' : undefined}>
      {title || aside ? (
        <Group justify="space-between" wrap="nowrap" mb={description ? 4 : 'sm'}>
          {title ? <Text fw={600}>{title}</Text> : <span />}
          {aside ?? null}
        </Group>
      ) : null}
      {description ? (
        <Text c="dimmed" size="sm" mb="sm">
          {description}
        </Text>
      ) : null}
      {children}
    </MantineCard>
  );
}
