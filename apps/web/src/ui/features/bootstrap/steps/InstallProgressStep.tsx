// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from 'react';
import { Code, Paper, Stack, Text, VisuallyHidden } from '@mantine/core';
import { Alert, Button, StepProgress, WizardFrame, type ProgressStep } from '../../../components';
import { redactSecrets } from '../../../lib/formatting';
import { INSTALL_STEPS, installStepIndexForFailure } from '../../../lib/wizard-view';
import { StepFooter } from './shared';

export interface InstallProgressStepProps {
  phase: 'running' | 'failed';
  error?: string;
  /** Server-reported failure phase (`InstallOutcome.failedStep`). */
  failedStep?: string;
  onRetry?: () => void;
  onBack?: () => void;
}

export function InstallProgressStep({ phase, error, failedStep, onRetry, onBack }: InstallProgressStepProps): JSX.Element {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = window.setInterval(() => {
      setIndex((i) => Math.min(i + 1, INSTALL_STEPS.length - 2));
    }, 750);
    return () => window.clearInterval(timer);
  }, [phase]);

  // On failure, trust the server's reported phase over the display animation's
  // position so the failed marker lands on the step that actually stopped.
  const mappedFailIndex = installStepIndexForFailure(failedStep);
  const failIndex = phase === 'failed' && mappedFailIndex >= 0 ? mappedFailIndex : index;

  const steps: ProgressStep[] = INSTALL_STEPS.map((s, i) => {
    const state: ProgressStep['state'] =
      phase === 'failed'
        ? i < failIndex
          ? 'success'
          : i === failIndex
            ? 'failed'
            : 'waiting'
        : i < index
          ? 'success'
          : i === index
            ? 'running'
            : 'waiting';
    return { id: s.id, label: s.label, state, ...(s.note ? { note: s.note } : {}) };
  });

  const current = INSTALL_STEPS[Math.min(index, INSTALL_STEPS.length - 1)];

  return (
    <WizardFrame
      eyebrow="Install"
      title={phase === 'failed' ? 'Installation stopped' : 'Installing SelfHelp…'}
      lead={
        phase === 'failed'
          ? 'Something went wrong before the install completed. No instance was brought online.'
          : 'This can take a few minutes. Keep this page open — you can watch each step below.'
      }
      footer={
        phase === 'failed' ? (
          <StepFooter
            onBack={onBack}
            primary={
              onRetry ? (
                <Button variant="primary" onClick={onRetry}>
                  Retry installation
                </Button>
              ) : (
                <span />
              )
            }
          />
        ) : undefined
      }
    >
      <VisuallyHidden role="status" aria-live="polite">
        {phase === 'running' ? `Installing: ${current?.label ?? ''}` : 'Installation failed.'}
      </VisuallyHidden>

      {phase === 'failed' && error ? (
        <Alert tone="error" title="What failed">
          <Stack gap="xs">
            <Text>{redactSecrets(error)}</Text>
            <Code block style={{ whiteSpace: 'pre-wrap' }}>
              {redactSecrets(error)}
            </Code>
          </Stack>
        </Alert>
      ) : (
        <Alert tone="info" title="Secrets are generated safely">
          Passwords and keys are written to restricted files. They are never displayed here.
        </Alert>
      )}

      <Paper withBorder radius="md" p="lg">
        <StepProgress steps={steps} />
      </Paper>
    </WizardFrame>
  );
}
