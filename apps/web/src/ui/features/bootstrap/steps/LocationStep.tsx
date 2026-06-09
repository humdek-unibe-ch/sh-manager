// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Code, Paper } from '@mantine/core';
import { Alert, Button, TextField, WizardFrame } from '../../../components';
import { STEP_COPY } from '../../../lib/wizard-view';
import { validateStep } from '../../../../wizard';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import { pickProblem, StepFooter } from './shared';

export interface LocationStepProps {
  ctl: BootstrapController;
}

export function LocationStep({ ctl }: LocationStepProps): JSX.Element {
  const cfg = ctl.effectiveConfig;
  if (!cfg) return <span />;
  const copy = STEP_COPY.install_root;
  const problems = validateStep('install_root', cfg);

  return (
    <WizardFrame
      eyebrow={copy?.eyebrow ?? 'Location'}
      title={copy?.title ?? 'Installation location'}
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
              Continue
            </Button>
          }
        />
      }
    >
      {ctl.state.actionError ? <Alert tone="error">{ctl.state.actionError}</Alert> : null}
      <Paper withBorder radius="md" p="lg">
        <TextField
          label="Install root"
          value={cfg.root}
          onChange={(v) => ctl.patchDraft({ root: v })}
          help="Absolute path on this server. Instances, secrets, proxy config and backups all live here."
          error={pickProblem(problems, 'root')}
          required
        />
      </Paper>
      <Alert tone="info" title="One root, many instances">
        Each instance gets its own subdirectory under <Code>{`${cfg.root || '/opt/selfhelp'}/instances`}</Code>. You can
        add more instances after the first install.
      </Alert>
    </WizardFrame>
  );
}
