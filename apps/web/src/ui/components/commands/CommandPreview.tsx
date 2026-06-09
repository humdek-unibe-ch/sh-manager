// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Code, CopyButton, Group } from '@mantine/core';
import { Button } from '../forms/Button';

export interface CommandPreviewProps {
  /** A shell command or URL to display and copy. Never pass secrets here. */
  value: string;
  label?: string;
}

export function CommandPreview({ value, label }: CommandPreviewProps): JSX.Element {
  return (
    <Group gap="xs" wrap="nowrap" align="stretch">
      <Code
        block
        aria-label={label ?? 'command'}
        style={{ flex: 1, minWidth: 0, overflowX: 'auto', margin: 0 }}
      >
        {value}
      </Code>
      <CopyButton value={value} timeout={1600}>
        {({ copied, copy }) => (
          <Button variant="ghost" onClick={copy} aria-label={`Copy ${label ?? 'command'}`}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        )}
      </CopyButton>
    </Group>
  );
}
