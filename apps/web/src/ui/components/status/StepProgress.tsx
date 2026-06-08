// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
export type StepState = 'waiting' | 'running' | 'success' | 'failed' | 'skipped';

export interface ProgressStep {
  id: string;
  label: string;
  state: StepState;
  note?: string;
}

export interface StepProgressProps {
  steps: ProgressStep[];
}

const MARKER: Record<StepState, string> = {
  waiting: '',
  running: '',
  success: '✓',
  failed: '×',
  skipped: '–',
};

export function StepProgress({ steps }: StepProgressProps): JSX.Element {
  return (
    <ol className="shm-steps">
      {steps.map((step, i) => (
        <li key={step.id} className={`shm-step shm-step--${step.state}`}>
          <span className="shm-step__marker" aria-hidden="true">
            {step.state === 'running' ? <span className="shm-spinner" /> : MARKER[step.state] || i + 1}
          </span>
          <span>
            <span className="shm-step__label">{step.label}</span>
            {step.note ? <span className="shm-step__note"> · {step.note}</span> : null}
            <span className="shm-visually-hidden">{` — ${step.state}`}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
