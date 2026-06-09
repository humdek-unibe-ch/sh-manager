// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Paper, SimpleGrid } from '@mantine/core';
import { Alert, Button, ChoiceCard, TextField, WizardFrame } from '../../../components';
import { STEP_COPY } from '../../../lib/wizard-view';
import { validateStep } from '../../../../wizard';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import type { InstanceMode } from '../../../lib/types';
import { pickProblem, StepFooter } from './shared';

export interface ModeStepProps {
  ctl: BootstrapController;
}

export function ModeStep({ ctl }: ModeStepProps): JSX.Element {
  const cfg = ctl.effectiveConfig;
  if (!cfg) return <span />;
  const copy = STEP_COPY.mode;
  const problems = validateStep('mode', cfg);

  const select = (mode: InstanceMode): void => ctl.patchDraft({ mode });

  return (
    <WizardFrame
      eyebrow={copy?.eyebrow ?? 'Installation mode'}
      title={copy?.title ?? 'How will this server be used?'}
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
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <ChoiceCard
          icon="🖥"
          title="Local Docker test"
          description="Run on localhost ports for development and evaluation."
          bullets={['No public domain or DNS needed', 'Binds to localhost', 'Great for trying SelfHelp']}
          selected={cfg.mode === 'local'}
          onSelect={() => select('local')}
        />
        <ChoiceCard
          icon="🌐"
          title="Production server"
          description="Public domain with automatic TLS via the shared Traefik proxy."
          bullets={['Public domain + HTTPS', 'DNS & port validation', 'Recommended for real installs']}
          selected={cfg.mode === 'production'}
          recommended
          onSelect={() => select('production')}
        />
      </SimpleGrid>

      <Paper withBorder radius="md" p="lg">
        <TextField
          label="Server id"
          value={cfg.serverId}
          onChange={(v) => ctl.patchDraft({ serverId: v })}
          help="A short identifier for this physical/virtual server, used in inventory and backups."
          placeholder="e.g. research-vm-1"
          error={pickProblem(problems, 'server id')}
          required
        />
      </Paper>

      {cfg.mode === 'production' ? (
        <Alert tone="info" title="Production checklist">
          You will need a domain name pointing at this server and ports 80/443 open. We validate both before installing.
        </Alert>
      ) : (
        <Alert tone="info" title="Local mode">
          The instance will be reachable at a localhost port on this machine only.
        </Alert>
      )}
    </WizardFrame>
  );
}
