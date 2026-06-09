// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Avatar, Group, Stack, Text } from '@mantine/core';

export interface BrandProps {
  subtitle?: string;
}

export function Brand({ subtitle }: BrandProps): JSX.Element {
  return (
    <Group gap="sm" wrap="nowrap">
      <Avatar radius="md" color="blue" variant="filled" aria-hidden="true">
        SH
      </Avatar>
      <Stack gap={0}>
        <Text fw={700} lh={1.2}>
          SelfHelp Manager
        </Text>
        {subtitle ? (
          <Text size="xs" c="dimmed">
            {subtitle}
          </Text>
        ) : null}
      </Stack>
    </Group>
  );
}
