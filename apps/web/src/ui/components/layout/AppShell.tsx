// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Box, Container, Group, Text } from '@mantine/core';
import { Brand } from './Brand';

export interface AppShellProps {
  subtitle?: string;
  /** Manager version shown in the header brand + footer. */
  version?: string;
  /** Rendered on the right of the header (status badge, sign-out, …). */
  headerActions?: ReactNode;
  children: ReactNode;
}

export function AppShell({ subtitle, version, headerActions, children }: AppShellProps): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col">
      <Box
        component="header"
        px="md"
        py="sm"
        style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
      >
        <Container size="lg" px={0}>
          <Group justify="space-between" wrap="nowrap">
            <Brand subtitle={subtitle} version={version} />
            {headerActions ? <Group gap="sm">{headerActions}</Group> : null}
          </Group>
        </Container>
      </Box>

      <Box component="main" className="flex-1" py="xl">
        <Container size="lg">{children}</Container>
      </Box>

      <Box component="footer" px="md" py="md">
        <Text ta="center" c="dimmed" size="xs">
          SelfHelp Manager{version ? ` v${version}` : ''} · Docker-only connected installer · runs locally, never
          exposes secrets
        </Text>
      </Box>
    </div>
  );
}
