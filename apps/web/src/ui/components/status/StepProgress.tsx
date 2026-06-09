// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Group, Loader, Stack, Text, ThemeIcon, VisuallyHidden } from '@mantine/core';

export type StepState = 'waiting' | 'running' | 'success' | 'failed' | 'skipped';

export interface ProgressStep {
  id: string;
  label: string;
  state: StepState;
  note?: string;
}

export interface StepProgressProps {
  steps: ProgressStep[];
}

const MARKER: Record<StepState, string> = {
  waiting: '',
  running: '',
  success: '✓',
  failed: '×',
  skipped: '–',
};

const COLOR: Record<StepState, string> = {
  waiting: 'gray',
  running: 'blue',
  success: 'teal',
  failed: 'red',
  skipped: 'gray',
};

const VARIANT: Record<StepState, string> = {
  waiting: 'light',
  running: 'light',
  success: 'filled',
  failed: 'filled',
  skipped: 'light',
};

export function StepProgress({ steps }: StepProgressProps): JSX.Element {
  return (
    <Stack gap="xs" component="ol" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {steps.map((step, i) => (
        <Group key={step.id} component="li" gap="sm" wrap="nowrap" align="center">
          <ThemeIcon color={COLOR[step.state]} variant={VARIANT[step.state]} radius="xl" size="sm" aria-hidden="true">
            {step.state === 'running' ? (
              <Loader size={12} color={COLOR[step.state]} />
            ) : (
              <Text span fz={11} fw={700}>
                {MARKER[step.state] || i + 1}
              </Text>
            )}
          </ThemeIcon>
          <Text size="sm">
            <Text span fw={500}>
              {step.label}
            </Text>
            {step.note ? (
              <Text span c="dimmed">
                {' '}
                · {step.note}
              </Text>
            ) : null}
            <VisuallyHidden>{` — ${step.state}`}</VisuallyHidden>
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
