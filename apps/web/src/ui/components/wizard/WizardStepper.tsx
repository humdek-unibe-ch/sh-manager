// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
export interface WizardStepperProps {
  phases: { id: string; label: string }[];
  activeIndex: number;
}

export function WizardStepper({ phases, activeIndex }: WizardStepperProps): JSX.Element {
  return (
    <nav aria-label="Installation progress">
      <ol className="shm-stepper" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {phases.map((phase, i) => {
          const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'todo';
          return (
            <li key={phase.id} className={`shm-stepper__item shm-stepper__item--${state}`}>
              <span className="shm-stepper__pill" aria-current={state === 'active' ? 'step' : undefined}>
                <span className="shm-stepper__num" aria-hidden="true">
                  {state === 'done' ? '✓' : i + 1}
                </span>
                {phase.label}
              </span>
              {i < phases.length - 1 ? <span className="shm-stepper__sep" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
