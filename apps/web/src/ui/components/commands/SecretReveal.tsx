// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * The ONE sanctioned place a secret value meets the UI: the install-time
 * "retrieved from the server, shown once" moment (e.g. the generated admin
 * password riding on the one-shot install response). The value is masked until
 * the operator explicitly reveals it and can always be copied without
 * revealing. Never use this for secrets persisted in any client-side state.
 */
import { useState } from 'react';
import { Code, CopyButton, Group } from '@mantine/core';
import { Button } from '../forms/Button';

export interface SecretRevealProps {
  /** The secret value (held only in this component's render props). */
  value: string;
  /** Accessible label, e.g. "generated admin password". */
  label: string;
}

export function SecretReveal({ value, label }: SecretRevealProps): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <Group gap="xs" wrap="nowrap" align="stretch">
      <Code
        block
        aria-label={label}
        style={{ flex: 1, minWidth: 0, overflowX: 'auto', margin: 0 }}
      >
        {revealed ? value : '•'.repeat(Math.max(value.length, 8))}
      </Code>
      <Button variant="ghost" onClick={() => setRevealed((r) => !r)} aria-label={`${revealed ? 'Hide' : 'Reveal'} ${label}`}>
        {revealed ? 'Hide' : 'Reveal'}
      </Button>
      <CopyButton value={value} timeout={1600}>
        {({ copied, copy }) => (
          <Button variant="ghost" onClick={copy} aria-label={`Copy ${label}`}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        )}
      </CopyButton>
    </Group>
  );
}
