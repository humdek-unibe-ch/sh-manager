// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Group, Stack, Text, Title } from '@mantine/core';

export interface WizardFrameProps {
  eyebrow?: string;
  title: string;
  lead?: string;
  children: ReactNode;
  /** Footer navigation (Back / Continue …). Omit on terminal screens. */
  footer?: ReactNode;
}

export function WizardFrame({ eyebrow, title, lead, children, footer }: WizardFrameProps): JSX.Element {
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        {eyebrow ? (
          <Text size="xs" tt="uppercase" fw={700} c="dimmed">
            {eyebrow}
          </Text>
        ) : null}
        <Title order={2}>{title}</Title>
        {lead ? <Text c="dimmed">{lead}</Text> : null}
      </Stack>

      <Stack gap="md">{children}</Stack>

      {footer ? (
        <Group justify="space-between" mt="sm">
          {footer}
        </Group>
      ) : null}
    </Stack>
  );
}
