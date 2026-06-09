// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { useState } from 'react';
import { Code, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { Alert, Button, Checkbox, KeyValue, StatusBadge, WizardFrame, type KeyValueRow } from '../../../components';
import { instanceDir, publicUrlPreview } from '../../../lib/formatting';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import { StepFooter } from './shared';

const SERVICES = ['Application server', 'MySQL database', 'Redis cache', 'Reverse proxy (shared Traefik)'];

export interface ReviewStepProps {
  ctl: BootstrapController;
}

export function ReviewStep({ ctl }: ReviewStepProps): JSX.Element {
  const cfg = ctl.effectiveConfig;
  const [confirmed, setConfirmed] = useState(false);
  if (!cfg) return <span />;

  const dir = instanceDir(cfg.root, cfg.instanceId);
  const summary: KeyValueRow[] = [
    { key: 'Instance name', value: cfg.instanceName || '—' },
    { key: 'Instance id', value: cfg.instanceId || '—', mono: true },
    { key: 'Public URL', value: publicUrlPreview(cfg), mono: true },
    { key: 'Install mode', value: cfg.mode === 'production' ? 'Production server' : 'Local Docker test' },
    { key: 'Server id', value: cfg.serverId || '—', mono: true },
    { key: 'Registry channel', value: cfg.channel },
    { key: 'SelfHelp version', value: cfg.version, mono: true },
    { key: 'Admin', value: cfg.adminEmail ? `${cfg.adminName ?? 'Admin'} <${cfg.adminEmail}>` : 'Create later' },
  ];

  const paths: KeyValueRow[] = [
    { key: 'Instance directory', value: dir, mono: true },
    { key: 'Manifest', value: `${dir}/manifest.json`, mono: true },
    { key: 'Lock file', value: `${dir}/lock.json`, mono: true },
    { key: 'Operator README', value: `${dir}/README.md`, mono: true },
    { key: 'Backups', value: `${dir}/backups`, mono: true },
  ];

  return (
    <WizardFrame
      eyebrow="Review"
      title="Review before installing"
      lead="Check everything below. Installation creates Docker resources and writes files on this server."
      footer={
        <StepFooter
          onBack={() => void ctl.goBack()}
          backDisabled={ctl.state.installing}
          primary={
            <Button
              variant="primary"
              size="lg"
              onClick={() => void ctl.install()}
              loading={ctl.state.installing}
              disabled={!confirmed}
            >
              Install SelfHelp
            </Button>
          }
        />
      }
    >
      {ctl.state.installError ? (
        <Alert tone="error" title="The previous attempt failed">
          {ctl.state.installError}
        </Alert>
      ) : null}

      <Paper withBorder radius="md" p="lg">
        <Stack gap="sm">
          <Text size="xs" tt="uppercase" fw={700} c="dimmed">
            Summary
          </Text>
          <KeyValue rows={summary} />
        </Stack>
      </Paper>

      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Paper withBorder radius="md" p="lg">
          <Stack gap="sm">
            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
              Docker services
            </Text>
            <Group gap="xs">
              {SERVICES.map((s) => (
                <StatusBadge key={s} tone="neutral" dot>
                  {s}
                </StatusBadge>
              ))}
            </Group>
          </Stack>
        </Paper>
        <Paper withBorder radius="md" p="lg">
          <Stack gap="sm">
            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
              Generated paths
            </Text>
            <KeyValue rows={paths} />
          </Stack>
        </Paper>
      </SimpleGrid>

      <Alert tone="info" title="About secrets">
        Secrets (database passwords, app keys, the admin password) are generated and stored in restricted files. They are
        never shown in this wizard — the admin password appears once on the success screen.
      </Alert>

      <Paper withBorder radius="md" p="lg">
        <Checkbox checked={confirmed} onChange={setConfirmed}>
          I understand this will create Docker resources and write files under <Code>{cfg.root || '/opt/selfhelp'}</Code>.
        </Checkbox>
      </Paper>
    </WizardFrame>
  );
}
