// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { useId } from 'react';
import type { ReactNode } from 'react';

export interface FieldRenderProps {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

export interface FieldProps {
  label: string;
  help?: string;
  error?: string;
  required?: boolean;
  /** Render-prop so the control gets the generated id + aria wiring. */
  children: (props: FieldRenderProps) => ReactNode;
}

/**
 * Accessible field wrapper: associates label, help text and error with the
 * control via `aria-describedby` / `aria-invalid` and a generated id. Errors are
 * announced with `aria-live` and connected to the field (not colour-only).
 */
export function Field({ label, help, error, required, children }: FieldProps): JSX.Element {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="shm-field">
      <label className="shm-field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="shm-field__req" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {help ? (
        <span className="shm-field__help" id={helpId}>
          {help}
        </span>
      ) : null}
      {error ? (
        <span className="shm-field__error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
