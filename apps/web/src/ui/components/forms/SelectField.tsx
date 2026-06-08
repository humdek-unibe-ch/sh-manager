// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Field } from './Field';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  help?: string;
  error?: string;
  required?: boolean;
}

export function SelectField({ label, value, options, onChange, help, error, required }: SelectFieldProps): JSX.Element {
  return (
    <Field label={label} help={help} error={error} required={required}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          className="shm-select"
          value={value}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
