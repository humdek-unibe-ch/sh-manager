// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Group, List, Paper, Stack, Text } from '@mantine/core';
import { Alert, Button, WizardFrame } from '../../../components';
import { STEP_COPY } from '../../../lib/wizard-view';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import { StepFooter } from './shared';

export interface ProxyStepProps {
  ctl: BootstrapController;
}

export function ProxyStep({ ctl }: ProxyStepProps): JSX.Element {
  const cfg = ctl.effectiveConfig;
  if (!cfg) return <span />;
  const copy = STEP_COPY.proxy;
  const isProd = cfg.mode === 'production';

  return (
    <WizardFrame
      eyebrow={copy?.eyebrow ?? 'Networking'}
      title={copy?.title ?? 'Shared reverse proxy'}
      lead={copy?.lead}
      footer={
        <StepFooter
          onBack={() => void ctl.goBack()}
          backDisabled={ctl.state.busy}
          primary={
            <Button variant="primary" onClick={() => void ctl.continueStep()} loading={ctl.state.busy}>
              Continue
            </Button>
          }
        />
      }
    >
      <Paper withBorder radius="md" p="lg">
        <Stack gap="sm">
          <Group gap="sm" wrap="nowrap">
            <Text fz={24} aria-hidden="true">
              🔀
            </Text>
            <div>
              <Text fw={600}>Traefik router</Text>
              <Text size="sm" c="dimmed">
                One proxy handles routing for every instance on this server.
              </Text>
            </div>
          </Group>
          <List size="sm" c="dimmed">
            <List.Item>Routes each instance by its domain or port</List.Item>
            {isProd ? (
              <List.Item>Obtains and renews TLS certificates automatically</List.Item>
            ) : (
              <List.Item>Exposes the instance on its localhost port</List.Item>
            )}
            <List.Item>Created once and reused by future instances</List.Item>
          </List>
        </Stack>
      </Paper>
      <Alert tone="info" title="Nothing to configure here">
        The proxy is set up automatically with safe defaults. Continue when you are ready.
      </Alert>
    </WizardFrame>
  );
}
