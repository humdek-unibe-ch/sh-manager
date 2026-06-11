// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Avatar, Group, Stack, Text } from '@mantine/core';

export interface BrandProps {
  subtitle?: string;
  /** Manager version, rendered next to the product name (e.g. "v1.0.6"). */
  version?: string;
}

export function Brand({ subtitle, version }: BrandProps): JSX.Element {
  return (
    <Group gap="sm" wrap="nowrap">
      <Avatar radius="md" color="blue" variant="filled" aria-hidden="true">
        SH
      </Avatar>
      <Stack gap={0}>
        <Group gap="xs" wrap="nowrap">
          <Text fw={700} lh={1.2}>
            SelfHelp Manager
          </Text>
          {version ? (
            <Text size="xs" c="dimmed" lh={1.2}>
              v{version}
            </Text>
          ) : null}
        </Group>
        {subtitle ? (
          <Text size="xs" c="dimmed">
            {subtitle}
          </Text>
        ) : null}
      </Stack>
    </Group>
  );
}
