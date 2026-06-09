// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Alert as MantineAlert } from '@mantine/core';

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

export interface AlertProps {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
}

const COLOR: Record<AlertTone, string> = {
  info: 'blue',
  success: 'teal',
  warning: 'yellow',
  error: 'red',
};

export function Alert({ tone = 'info', title, children }: AlertProps): JSX.Element {
  return (
    <MantineAlert
      color={COLOR[tone]}
      variant="light"
      title={title}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </MantineAlert>
  );
}
