// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Checkbox as MantineCheckbox } from '@mantine/core';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}

export function Checkbox({ checked, onChange, children }: CheckboxProps): JSX.Element {
  return (
    <MantineCheckbox
      checked={checked}
      onChange={(e) => onChange(e.currentTarget.checked)}
      label={children}
    />
  );
}
