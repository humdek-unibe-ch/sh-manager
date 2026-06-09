// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Group, List, Paper, Text } from '@mantine/core';
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
      <Group gap="xs" wrap="wrap">
        <StatusBadge tone="info">Bootstrap mode</StatusBadge>
        <StatusBadge tone="neutral">Localhost / private access</StatusBadge>
        <StatusBadge tone="ok">Docker-only</StatusBadge>
      </Group>

      <Alert tone="info" title="Safe by design">
        The installer is only reachable from this machine. Connect over an SSH tunnel for a remote server. Generated
        passwords and keys are written to restricted files and shown to you once after the install completes.
      </Alert>

      <Paper withBorder radius="md" p="lg">
        <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb="sm">
          What happens next
        </Text>
        <List type="ordered" spacing="xs">
          {phases.map((p) => (
            <List.Item key={p.id}>
              <Text span fw={600}>
                {p.label}
              </Text>
            </List.Item>
          ))}
        </List>
      </Paper>
    </WizardFrame>
  );
}
