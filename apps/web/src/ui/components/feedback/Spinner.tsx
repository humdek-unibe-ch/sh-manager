// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
export interface SpinnerProps {
  size?: 'sm' | 'lg';
  label?: string;
}

export function Spinner({ size = 'sm', label = 'Loading' }: SpinnerProps): JSX.Element {
  return (
    <span className={size === 'lg' ? 'shm-spinner shm-spinner--lg' : 'shm-spinner'} role="status" aria-label={label} />
  );
}
