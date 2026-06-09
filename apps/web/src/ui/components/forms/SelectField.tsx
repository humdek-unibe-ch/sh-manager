// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Select } from '@mantine/core';

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
    <Select
      label={label}
      description={help}
      error={error}
      required={required}
      data={options}
      value={value}
      onChange={(val) => onChange(val ?? '')}
      allowDeselect={false}
      checkIconPosition="right"
      comboboxProps={{ withinPortal: true }}
    />
  );
}
