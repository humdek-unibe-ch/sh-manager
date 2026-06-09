// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Loader } from '@mantine/core';

export interface SpinnerProps {
  size?: 'sm' | 'lg';
  label?: string;
}

/** Thin wrapper over Mantine's `Loader` with an accessible status label. */
export function Spinner({ size = 'sm', label = 'Loading' }: SpinnerProps): JSX.Element {
  return <Loader size={size === 'lg' ? 'lg' : 'sm'} role="status" aria-label={label} />;
}
