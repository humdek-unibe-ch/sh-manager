// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Alert, Button, StatusBadge, WizardFrame } from '../../../components';
import { WIZARD_PHASES } from '../../../lib/wizard-view';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import { StepFooter } from './shared';

export interface WelcomeStepProps {
  ctl: BootstrapController;
}

export function WelcomeStep({ ctl }: WelcomeStepProps): JSX.Element {
  const phases = WIZARD_PHASES.filter((p) => p.id !== 'welcome' && p.id !== 'done');

  return (
    <WizardFrame
      eyebrow="Welcome"
      title="Set up SelfHelp on this server"
      lead="This guided installer creates and manages isolated SelfHelp Docker instances. It runs locally, verifies official releases, and never displays secrets."
      footer={
        <StepFooter
          primary={
            <Button variant="primary" size="lg" onClick={() => void ctl.continueStep()} loading={ctl.state.busy}>
              Start setup
            </Button>
          }
        />
      }
    >
      <div className="shm-row shm-row--wrap" style={{ gap: 'var(--shm-space-2)' }}>
        <StatusBadge tone="info">Bootstrap mode</StatusBadge>
        <StatusBadge tone="neutral">Localhost / private access</StatusBadge>
        <StatusBadge tone="ok">Docker-only</StatusBadge>
      </div>

      <Alert tone="info" title="Safe by design">
        The installer is only reachable from this machine. Connect over an SSH tunnel for a remote server. Generated
        passwords and keys are written to restricted files and shown to you once after the install completes.
      </Alert>

      <div className="shm-card shm-card--pad">
        <div className="shm-eyebrow" style={{ marginBottom: 'var(--shm-space-3)' }}>
          What happens next
        </div>
        <ol className="shm-stack shm-stack--2" style={{ margin: 0, paddingLeft: '1.1em' }}>
          {phases.map((p) => (
            <li key={p.id}>
              <span style={{ fontWeight: 600 }}>{p.label}</span>
            </li>
          ))}
        </ol>
      </div>
    </WizardFrame>
  );
}
