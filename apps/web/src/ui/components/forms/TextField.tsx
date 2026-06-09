// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { TextInput } from '@mantine/core';

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  type?: 'text' | 'email' | 'number';
  inputMode?: 'text' | 'numeric' | 'email';
  autoComplete?: string;
  /** Optional trailing adornment, e.g. a unit or fixed suffix. */
  suffix?: ReactNode;
}

export function TextField({
  label,
  value,
  onChange,
  help,
  error,
  required,
  placeholder,
  type = 'text',
  inputMode,
  autoComplete,
  suffix,
}: TextFieldProps): JSX.Element {
  return (
    <TextInput
      label={label}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      description={help}
      error={error}
      required={required}
      placeholder={placeholder}
      type={type}
      inputMode={inputMode}
      autoComplete={autoComplete}
      rightSection={suffix}
      rightSectionWidth={suffix ? undefined : 0}
    />
  );
}
