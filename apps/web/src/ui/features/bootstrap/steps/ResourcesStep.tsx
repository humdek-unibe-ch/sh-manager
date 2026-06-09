// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Group, List, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import {
  Alert,
  Button,
  MetricCard,
  StatusBadge,
  WizardFrame,
  type BadgeTone,
  type MetricStatus,
} from '../../../components';
import { CHECK_META } from '../../../lib/wizard-view';
import { instanceDir, splitDetail } from '../../../lib/formatting';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import type { CheckResult } from '../../../lib/types';
import { StepFooter } from './shared';

function statusOf(result: CheckResult | undefined): { tone: BadgeTone; metric: MetricStatus; label: string } {
  if (!result) return { tone: 'pending', metric: 'neutral', label: 'Not checked' };
  if (result.severity === 'error' || !result.ok) return { tone: 'error', metric: 'blocked', label: 'Blocked' };
  if (result.severity === 'warning') return { tone: 'warning', metric: 'warning', label: 'Warning' };
  return { tone: 'ok', metric: 'ok', label: 'Good' };
}

export interface ResourcesStepProps {
  ctl: BootstrapController;
}

export function ResourcesStep({ ctl }: ResourcesStepProps): JSX.Element {
  const { state } = ctl;
  const cfg = ctl.effectiveConfig;
  const snap = state.snapshot;
  if (!cfg || !snap) return <span />;

  const result = snap.checks.resources;
  const status = statusOf(result);
  const ran = Boolean(result);
  const lines = splitDetail(result?.detail);
  const requiredPorts = cfg.mode === 'production' ? '80, 443 (HTTP/HTTPS)' : `localhost:${cfg.localPort ?? 8080}`;

  const primary =
    ran && snap.canAdvance.ok ? (
      <Button variant="primary" onClick={() => void ctl.continueStep()} loading={state.busy}>
        Continue
      </Button>
    ) : (
      <Button
        variant="primary"
        onClick={() => void ctl.runCheck('resources')}
        loading={state.runningCheck === 'resources'}
      >
        {ran ? 'Re-run resource check' : 'Run resource check'}
      </Button>
    );

  return (
    <WizardFrame
      eyebrow="Resources"
      title="Resource & port preflight"
      lead="We confirm there is enough disk and memory, and that the ports this install needs are free."
      footer={<StepFooter onBack={() => void ctl.goBack()} backDisabled={state.busy} primary={primary} />}
    >
      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
        <MetricCard label="Install root" value={cfg.root || '/opt/selfhelp'} status="neutral" />
        <MetricCard
          label="Backups"
          value={`${instanceDir(cfg.root, cfg.instanceId || 'instance')}/backups`}
          status="neutral"
        />
        <MetricCard label="Required ports" value={requiredPorts} status={status.metric} />
        <MetricCard
          label="Preflight"
          value={status.label}
          status={status.metric}
          hint={ran ? undefined : 'Run the check'}
        />
      </SimpleGrid>

      {state.actionError ? <Alert tone="error">{state.actionError}</Alert> : null}

      {ran ? (
        <Paper withBorder radius="md" p="lg">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600}>Result</Text>
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            </Group>
            {lines.length > 0 ? (
              <List size="sm" c="dimmed">
                {lines.map((l) => (
                  <List.Item key={l}>{l}</List.Item>
                ))}
              </List>
            ) : (
              <Text c="dimmed">No issues reported.</Text>
            )}
            {status.metric === 'blocked' ? (
              <Alert tone="error" title="Not enough resources to continue">
                {CHECK_META.resources?.fix}
              </Alert>
            ) : status.metric === 'warning' ? (
              <Alert tone="warning" title="Acceptable, but not ideal">
                You can continue, but consider addressing the warnings above before going to production.
              </Alert>
            ) : null}
          </Stack>
        </Paper>
      ) : (
        <Alert tone="info" title="Nothing is created yet">
          Running this check inspects the system only. {CHECK_META.resources?.description}
        </Alert>
      )}
    </WizardFrame>
  );
}
