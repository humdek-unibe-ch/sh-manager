// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Button } from '../../../components';

/** Find the first validation message that mentions any of the given needles. */
export function pickProblem(problems: string[], ...needles: string[]): string | undefined {
  return problems.find((p) => needles.some((n) => p.toLowerCase().includes(n)));
}

export interface StepFooterProps {
  onBack?: () => void;
  backDisabled?: boolean;
  /** Right-aligned primary control(s). */
  primary: ReactNode;
}

/** Consistent Back / primary footer used by every wizard step. */
export function StepFooter({ onBack, backDisabled, primary }: StepFooterProps): JSX.Element {
  return (
    <>
      {onBack ? (
        <Button variant="ghost" onClick={onBack} disabled={backDisabled}>
          ← Back
        </Button>
      ) : (
        <span />
      )}
      <div className="shm-frame__footer-end">{primary}</div>
    </>
  );
}
