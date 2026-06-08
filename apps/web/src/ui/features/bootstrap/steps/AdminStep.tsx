// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Alert, Button, TextField, WizardFrame } from '../../../components';
import { STEP_COPY } from '../../../lib/wizard-view';
import { validateStep } from '../../../../wizard';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import { pickProblem, StepFooter } from './shared';

export interface AdminStepProps {
  ctl: BootstrapController;
}

export function AdminStep({ ctl }: AdminStepProps): JSX.Element {
  const cfg = ctl.effectiveConfig;
  if (!cfg) return <span />;
  const copy = STEP_COPY.admin;
  const problems = validateStep('admin', cfg);

  return (
    <WizardFrame
      eyebrow={copy?.eyebrow ?? 'Administrator'}
      title={copy?.title ?? 'First administrator'}
      lead={copy?.lead}
      footer={
        <StepFooter
          onBack={() => void ctl.goBack()}
          backDisabled={ctl.state.busy}
          primary={
            <Button
              variant="primary"
              onClick={() => void ctl.continueStep()}
              loading={ctl.state.busy}
              disabled={problems.length > 0}
            >
              Review install
            </Button>
          }
        />
      }
    >
      <div className="shm-card shm-card--pad shm-stack shm-stack--4">
        <TextField
          label="Admin email"
          type="email"
          value={cfg.adminEmail ?? ''}
          onChange={(v) => ctl.patchDraft({ adminEmail: v })}
          help="Optional. The first administrator account. Leave blank to create it later."
          placeholder="admin@university.edu"
          error={pickProblem(problems, 'admin email')}
        />
        <TextField
          label="Admin name"
          value={cfg.adminName ?? ''}
          onChange={(v) => ctl.patchDraft({ adminName: v })}
          help="Optional display name for the first administrator."
          placeholder="Admin"
        />
      </div>

      <Alert tone="success" title="Passwords are never entered here">
        The administrator password is generated securely during installation and shown to you once on the success
        screen. It is never typed into this form or stored in the wizard.
      </Alert>
    </WizardFrame>
  );
}
