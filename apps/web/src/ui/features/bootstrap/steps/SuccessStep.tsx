// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Button, Code, Group, Paper, SimpleGrid, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { Alert, CommandPreview, KeyValue, SecretReveal, StatusBadge, type BadgeTone, type KeyValueRow } from '../../../components';
import { instanceDir, publicUrlPreview } from '../../../lib/formatting';
import type { InstallResult, Snapshot, WizardConfig } from '../../../lib/types';

export interface SuccessStepProps {
  result: InstallResult | null;
  config: WizardConfig;
  snapshot: Snapshot;
}

function healthBadge(result: InstallResult | null, snapshot: Snapshot): { tone: BadgeTone; label: string } {
  const health = result?.health;
  if (health) {
    if (health.healthy && !health.degraded) return { tone: 'ok', label: 'All services healthy' };
    if (health.degraded) return { tone: 'warning', label: 'Running, some services degraded' };
    return { tone: 'error', label: 'Health checks did not pass' };
  }
  const check = snapshot.checks.health;
  if (!check) return { tone: 'neutral', label: 'Health unknown' };
  if (check.severity === 'warning') return { tone: 'warning', label: 'Running, some services degraded' };
  if (check.severity === 'error' || !check.ok) return { tone: 'error', label: 'Health checks did not pass' };
  return { tone: 'ok', label: 'All services healthy' };
}

export function SuccessStep({ result, config, snapshot }: SuccessStepProps): JSX.Element {
  const url = result?.publicUrl ?? publicUrlPreview(config);
  const dir = result?.outcome.instanceDir ?? instanceDir(config.root, config.instanceId);
  const version = result?.outcome.version ?? config.version;
  const health = healthBadge(result, snapshot);

  const paths: KeyValueRow[] = [
    { key: 'Instance directory', value: dir, mono: true },
    { key: 'Manifest', value: `${dir}/manifest.json`, mono: true },
    { key: 'Lock file', value: `${dir}/lock.json`, mono: true },
    { key: 'Operator README', value: `${dir}/README.md`, mono: true },
    { key: 'Backups', value: `${dir}/backups`, mono: true },
  ];

  return (
    <Stack gap="lg">
      <Stack align="center" gap="sm">
        <ThemeIcon color="teal" variant="light" radius="xl" size={60}>
          <Text fz={28} aria-hidden="true">
            ✓
          </Text>
        </ThemeIcon>
        <Title order={2} ta="center">
          {config.instanceName || 'Your instance'} is ready
        </Title>
        <Text c="dimmed" ta="center">
          SelfHelp {version} is installed and the services have been started.
        </Text>
        <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
      </Stack>

      <Paper withBorder radius="md" p="lg">
        <Stack gap="sm">
          <Text size="xs" tt="uppercase" fw={700} c="dimmed">
            Open your instance
          </Text>
          <CommandPreview value={url} label="public URL" />
          <Group>
            <Button component="a" href={url} target="_blank" rel="noreferrer noopener" size="md">
              Open SelfHelp ↗
            </Button>
          </Group>
        </Stack>
      </Paper>

      {result?.outcome.adminPassword ? (
        <Paper withBorder radius="md" p="lg">
          <Stack gap="sm">
            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
              Administrator sign-in (shown once)
            </Text>
            {config.adminEmail ? <KeyValue rows={[{ key: 'Admin email', value: config.adminEmail, mono: true }]} /> : null}
            <SecretReveal value={result.outcome.adminPassword} label="generated admin password" />
            <Text size="xs" c="dimmed">
              Store it in your password manager now — it disappears from this screen when you leave or reload.
              {result.outcome.adminPasswordFile ? (
                <>
                  {' '}
                  It is also saved on the server in the owner-only file <Code>{result.outcome.adminPasswordFile}</Code>;
                  delete that file after your first sign-in.
                </>
              ) : null}
            </Text>
          </Stack>
        </Paper>
      ) : config.adminEmail ? (
        <Alert tone="warning" title="Retrieve your admin password from the server">
          The generated administrator password is stored in the owner-only file{' '}
          <Code>{`${dir}/secrets/admin_password`}</Code> on the server. Retrieve it now, store it in your password
          manager, then delete the file.
        </Alert>
      ) : null}

      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Paper withBorder radius="md" p="lg">
          <Stack gap="sm">
            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
              Important paths
            </Text>
            <KeyValue rows={paths} />
          </Stack>
        </Paper>
        <Paper withBorder radius="md" p="lg">
          <Stack gap="sm">
            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
              Operator commands
            </Text>
            <CommandPreview value={`sh-manager instance health ${config.instanceId}`} label="health command" />
            <CommandPreview value={`sh-manager backup create ${config.instanceId}`} label="backup command" />
            <Text size="xs" c="dimmed">
              Run these on the server. Full instructions are in the operator README above.
            </Text>
          </Stack>
        </Paper>
      </SimpleGrid>
    </Stack>
  );
}
