// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button as MantineButton } from '@mantine/core';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  size?: 'md' | 'lg';
  loading?: boolean;
  children: ReactNode;
}

/** Maps the app's button intents onto Mantine `Button` variants/colors. */
const STYLE: Record<ButtonVariant, { variant: string; color?: string }> = {
  primary: { variant: 'filled', color: 'blue' },
  secondary: { variant: 'default' },
  ghost: { variant: 'subtle', color: 'gray' },
  danger: { variant: 'filled', color: 'red' },
};

export function Button({
  variant = 'secondary',
  block = false,
  size = 'md',
  loading = false,
  disabled,
  children,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const style = STYLE[variant];
  return (
    <MantineButton
      {...rest}
      type={type}
      variant={style.variant}
      color={style.color}
      fullWidth={block}
      size={size === 'lg' ? 'lg' : 'md'}
      loading={loading}
      disabled={disabled}
    >
      {children}
    </MantineButton>
  );
}
