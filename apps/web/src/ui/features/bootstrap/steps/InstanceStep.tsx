// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Code, Paper, Stack } from '@mantine/core';
import { Alert, Button, SelectField, TextField, WizardFrame } from '../../../components';
import { STEP_COPY } from '../../../lib/wizard-view';
import { instanceDir, slugify } from '../../../lib/formatting';
import { validateStep } from '../../../../wizard';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import type { ReleaseChannel } from '../../../lib/types';
import { pickProblem, StepFooter } from './shared';

const CHANNELS: { value: ReleaseChannel; label: string }[] = [
  { value: 'stable', label: 'Stable — recommended' },
  { value: 'beta', label: 'Beta — early features' },
  { value: 'nightly', label: 'Nightly — latest, least tested' },
];

export interface InstanceStepProps {
  ctl: BootstrapController;
}

export function InstanceStep({ ctl }: InstanceStepProps): JSX.Element {
  const cfg = ctl.effectiveConfig;
  if (!cfg) return <span />;
  const copy = STEP_COPY.instance;
  const problems = validateStep('instance', cfg);

  const onName = (value: string): void => {
    // Auto-suggest the id while the operator hasn't customised it.
    const autoLinked = !cfg.instanceId || cfg.instanceId === slugify(cfg.instanceName);
    ctl.patchDraft(autoLinked ? { instanceName: value, instanceId: slugify(value) } : { instanceName: value });
  };

  return (
    <WizardFrame
      eyebrow={copy?.eyebrow ?? 'First instance'}
      title={copy?.title ?? 'Configure your first instance'}
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
      <Paper withBorder radius="md" p="lg">
        <Stack gap="md">
          <TextField
            label="Display name"
            value={cfg.instanceName}
            onChange={onName}
            help="A human-friendly name shown in the manager, e.g. “Clinic A”."
            placeholder="Clinic A"
            error={pickProblem(problems, 'display name')}
            required
          />
          <TextField
            label="Instance id"
            value={cfg.instanceId}
            onChange={(v) => ctl.patchDraft({ instanceId: v })}
            help="Lowercase letters, digits and hyphens. Used for folders, containers and routing."
            placeholder="clinic-a"
            error={pickProblem(problems, 'instance id')}
            required
          />
          <SelectField
            label="Release channel"
            value={cfg.channel}
            options={CHANNELS}
            onChange={(v) => ctl.patchDraft({ channel: v as ReleaseChannel })}
            help="Determines which verified releases are offered."
          />
          <TextField
            label="SelfHelp version"
            value={cfg.version}
            onChange={(v) => ctl.patchDraft({ version: v })}
            help='Use "latest" for the newest compatible release, or pin an exact version.'
            placeholder="latest"
          />
          <TextField
            label="Registry URL"
            value={cfg.registryUrl}
            onChange={(v) => ctl.patchDraft({ registryUrl: v })}
            help="The official signed release registry. Change only if you run a mirror."
            error={pickProblem(problems, 'registry')}
          />
        </Stack>
      </Paper>

      <Alert tone="info" title="Where it will live">
        Files: <Code>{instanceDir(cfg.root, cfg.instanceId || 'instance')}</Code>
      </Alert>
    </WizardFrame>
  );
}
