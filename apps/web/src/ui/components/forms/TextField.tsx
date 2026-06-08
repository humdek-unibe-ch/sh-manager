// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Field } from './Field';

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
    <Field label={label} help={help} error={error} required={required}>
      {({ id, describedBy, invalid }) => {
        const input = (
          <input
            id={id}
            className="shm-input"
            type={type}
            value={value}
            placeholder={placeholder}
            inputMode={inputMode}
            autoComplete={autoComplete}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            aria-required={required || undefined}
            onChange={(e) => onChange(e.target.value)}
          />
        );
        if (!suffix) return input;
        return (
          <div className="shm-input-group">
            {input}
            <span className="shm-input-group__suffix">{suffix}</span>
          </div>
        );
      }}
    </Field>
  );
}
