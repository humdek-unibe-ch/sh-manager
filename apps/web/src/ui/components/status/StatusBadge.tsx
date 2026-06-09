// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Badge } from '@mantine/core';

export type BadgeTone = 'ok' | 'warning' | 'error' | 'info' | 'neutral' | 'pending';

export interface StatusBadgeProps {
  tone: BadgeTone;
  children: string;
  /** Show a leading dot (status indication beyond colour is the text itself). */
  dot?: boolean;
}

const COLOR: Record<BadgeTone, string> = {
  ok: 'teal',
  warning: 'yellow',
  error: 'red',
  info: 'blue',
  neutral: 'gray',
  pending: 'gray',
};

export function StatusBadge({ tone, children, dot = true }: StatusBadgeProps): JSX.Element {
  return (
    <Badge
      color={COLOR[tone]}
      variant="light"
      size="md"
      leftSection={
        dot ? (
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', display: 'inline-block' }}
          />
        ) : undefined
      }
      // Status text is a short phrase, not an all-caps label, and must not be clipped.
      styles={{ label: { textTransform: 'none', overflow: 'visible' }, root: { maxWidth: 'none' } }}
    >
      {children}
    </Badge>
  );
}
