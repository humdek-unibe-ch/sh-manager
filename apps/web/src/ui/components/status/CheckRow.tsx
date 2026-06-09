// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Box, Code, Group, Loader, Spoiler, Text, ThemeIcon } from '@mantine/core';
import { redactSecrets } from '../../lib/formatting';

export type CheckStatus = 'pending' | 'running' | 'ok' | 'warning' | 'error';

export interface CheckRowProps {
  status: CheckStatus;
  title: string;
  description: string;
  /** Friendly one-line result, shown once the check has run. */
  detail?: string;
  /** Concrete suggested fix, shown only on failure. */
  fix?: string;
  /** Raw detail kept behind a "show technical details" disclosure. */
  technical?: string;
}

const ICON: Record<CheckStatus, string> = {
  pending: '○',
  running: '',
  ok: '✓',
  warning: '!',
  error: '×',
};

const LABEL: Record<CheckStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  ok: 'Passed',
  warning: 'Warning',
  error: 'Failed',
};

const COLOR: Record<CheckStatus, string> = {
  pending: 'gray',
  running: 'blue',
  ok: 'teal',
  warning: 'yellow',
  error: 'red',
};

export function CheckRow({ status, title, description, detail, fix, technical }: CheckRowProps): JSX.Element {
  return (
    <Group align="flex-start" wrap="nowrap" gap="sm">
      <ThemeIcon color={COLOR[status]} variant="light" radius="xl" size="md" aria-hidden="true">
        {status === 'running' ? <Loader size="xs" color={COLOR[status]} /> : <span>{ICON[status]}</span>}
      </ThemeIcon>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text fw={600}>{title}</Text>
          <Text size="xs" fw={600} c="dimmed">
            {LABEL[status]}
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          {detail ? redactSecrets(detail) : description}
        </Text>

        {status === 'error' && fix ? (
          <Text size="sm" c="red" mt={4}>
            Suggested fix: {fix}
          </Text>
        ) : null}

        {technical ? (
          <Spoiler maxHeight={0} showLabel="Show technical details" hideLabel="Hide technical details" mt={4}>
            <Code block style={{ whiteSpace: 'pre-wrap' }}>
              {redactSecrets(technical)}
            </Code>
          </Spoiler>
        ) : null}
      </Box>
    </Group>
  );
}
