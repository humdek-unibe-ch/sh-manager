// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
export type BadgeTone = 'ok' | 'warning' | 'error' | 'info' | 'neutral' | 'pending';

export interface StatusBadgeProps {
  tone: BadgeTone;
  children: string;
  /** Show a leading dot (status indication beyond colour is the text itself). */
  dot?: boolean;
}

export function StatusBadge({ tone, children, dot = true }: StatusBadgeProps): JSX.Element {
  return (
    <span className={`shm-badge shm-badge--${tone}`}>
      {dot ? <span className="shm-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
