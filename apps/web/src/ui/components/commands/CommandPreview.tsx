// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { useState } from 'react';
import { Button } from '../forms/Button';

export interface CommandPreviewProps {
  /** A shell command or URL to display and copy. Never pass secrets here. */
  value: string;
  label?: string;
}

export function CommandPreview({ value, label }: CommandPreviewProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be unavailable (insecure context) — selecting still works.
      setCopied(false);
    }
  }

  return (
    <div className="shm-command">
      <pre className="shm-command__code" aria-label={label ?? 'command'}>
        {value}
      </pre>
      <Button variant="ghost" onClick={() => void copy()} aria-label={`Copy ${label ?? 'command'}`}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
