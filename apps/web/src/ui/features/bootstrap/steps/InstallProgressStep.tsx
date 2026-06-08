// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from 'react';
import { Alert, Button, StepProgress, WizardFrame, type ProgressStep } from '../../../components';
import { redactSecrets } from '../../../lib/formatting';
import { INSTALL_STEPS } from '../../../lib/wizard-view';
import { StepFooter } from './shared';

export interface InstallProgressStepProps {
  phase: 'running' | 'failed';
  error?: string;
  onRetry?: () => void;
  onBack?: () => void;
}

export function InstallProgressStep({ phase, error, onRetry, onBack }: InstallProgressStepProps): JSX.Element {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = window.setInterval(() => {
      setIndex((i) => Math.min(i + 1, INSTALL_STEPS.length - 2));
    }, 750);
    return () => window.clearInterval(timer);
  }, [phase]);

  const steps: ProgressStep[] = INSTALL_STEPS.map((s, i) => {
    const state: ProgressStep['state'] =
      phase === 'failed'
        ? i < index
          ? 'success'
          : i === index
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
      <div aria-live="polite" aria-busy={phase === 'running'} className="shm-visually-hidden">
        {phase === 'running' ? `Installing: ${current?.label ?? ''}` : 'Installation failed.'}
      </div>

      {phase === 'failed' && error ? (
        <Alert tone="error" title="What failed">
          {redactSecrets(error)}
          <details className="shm-disclosure" style={{ marginTop: 'var(--shm-space-2)' }}>
            <summary className="shm-disclosure__btn">Show technical details</summary>
            <pre className="shm-command__code" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
              {redactSecrets(error)}
            </pre>
          </details>
        </Alert>
      ) : (
        <Alert tone="info" title="Secrets are generated safely">
          Passwords and keys are written to restricted files. They are never displayed here.
        </Alert>
      )}

      <div className="shm-card shm-card--pad">
        <StepProgress steps={steps} />
      </div>
    </WizardFrame>
  );
}
