// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from '../feedback/Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  size?: 'md' | 'lg';
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  block = false,
  size = 'md',
  loading = false,
  disabled,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    'shm-btn',
    `shm-btn--${variant}`,
    block ? 'shm-btn--block' : '',
    size === 'lg' ? 'shm-btn--lg' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
