// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Stepper } from '@mantine/core';

export interface WizardStepperProps {
  phases: { id: string; label: string }[];
  activeIndex: number;
}

export function WizardStepper({ phases, activeIndex }: WizardStepperProps): JSX.Element {
  return (
    <Stepper active={activeIndex} size="sm" aria-label="Installation progress">
      {phases.map((phase) => (
        <Stepper.Step key={phase.id} label={phase.label} />
      ))}
    </Stepper>
  );
}
