// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}

export function Checkbox({ checked, onChange, children }: CheckboxProps): JSX.Element {
  return (
    <label className="shm-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="shm-check__text">{children}</span>
    </label>
  );
}
