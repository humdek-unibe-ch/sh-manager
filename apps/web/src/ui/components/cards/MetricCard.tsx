// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Paper, Text } from '@mantine/core';

export type MetricStatus = 'ok' | 'warning' | 'blocked' | 'neutral';

export interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  status?: MetricStatus;
}

const COLOR: Record<MetricStatus, string | undefined> = {
  ok: 'teal',
  warning: 'yellow.8',
  blocked: 'red',
  neutral: undefined,
};

export function MetricCard({ label, value, hint, status = 'neutral' }: MetricCardProps): JSX.Element {
  return (
    <Paper withBorder radius="md" p="md">
      <Text size="xs" tt="uppercase" fw={700} c="dimmed">
        {label}
      </Text>
      <Text fw={600} c={COLOR[status]} style={{ wordBreak: 'break-word' }}>
        {value}
      </Text>
      {hint ? (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      ) : null}
    </Paper>
  );
}
