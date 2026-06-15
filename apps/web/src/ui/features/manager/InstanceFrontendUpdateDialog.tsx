// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Frontend-only update dialog: dry-run first, execute second.
 *
 * The frontend ships independently of the core, so an instance already on the
 * latest core can still have a newer compatible frontend. This is the
 * lightweight path: the dry-run resolves the newest compatible frontend (a pure
 * read), and execution swaps ONLY the frontend container — no database
 * migration, no full backup, no maintenance window, because the frontend is
 * stateless. The core stack and every volume stay untouched.
 */
import { useState } from 'react';
import { Code, Divider, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import type { FrontendUpdatePlan } from '@shm/core';
import { Alert, Button, Checkbox, StatusBadge, type BadgeTone } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { FrontendUpdateInstanceRequest } from '../../lib/types';
import { VersionSelect } from './VersionSelect';

function planTone(status: FrontendUpdatePlan['status']): BadgeTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'up_to_date':
      return 'neutral';
    default:
      return 'error';
  }
}

function isExecutable(plan: FrontendUpdatePlan): boolean {
  return plan.status === 'ok' && plan.frontend !== null;
}

export interface InstanceFrontendUpdateDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function InstanceFrontendUpdateDialog({
  client,
  instanceId,
  opened,
  onClose,
  onStarted,
}: InstanceFrontendUpdateDialogProps): JSX.Element {
  const [target, setTarget] = useState('');
  const [useTestChannel, setUseTestChannel] = useState(false);
  const [plan, setPlan] = useState<FrontendUpdatePlan | null>(null);

  function requestBody(): FrontendUpdateInstanceRequest {
    return {
      ...(target.trim() !== '' ? { target: target.trim() } : {}),
      ...(useTestChannel ? { channel: 'test' } : {}),
    };
  }

  const dryRun = useMutation({
    mutationFn: () => client.frontendUpdateDryRun(instanceId, requestBody()),
    onSuccess: (res) => setPlan(res.plan as FrontendUpdatePlan),
  });

  const execute = useMutation({
    mutationFn: () => client.executeFrontendUpdate(instanceId, requestBody()),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  function resetPlan(): void {
    setPlan(null);
  }

  const canExecute = plan !== null && isExecutable(plan) && !execute.isPending;

  return (
    <Modal opened={opened} onClose={onClose} title={`Update frontend — ${instanceId}`} size="lg" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          The frontend is released independently of the core. This swaps only the frontend container to a
          newer compatible release — no database migration, no maintenance window, and all data is left
          untouched. Run the dry-run first to resolve the target.
        </Text>

        <VersionSelect
          client={client}
          label="Target frontend version"
          {...(useTestChannel ? { channel: 'test' } : {})}
          value={target === '' ? 'latest' : target}
          onChange={(v) => {
            setTarget(v === 'latest' ? '' : v);
            resetPlan();
          }}
          help='Versions come from the verified release registry — "latest" resolves to the newest compatible frontend in the channel.'
        />
        <Checkbox
          checked={useTestChannel}
          onChange={(v) => {
            setUseTestChannel(v);
            resetPlan();
          }}
        >
          Use the test channel (pre-release builds)
        </Checkbox>

        <Group>
          <Button variant="secondary" loading={dryRun.isPending} onClick={() => dryRun.mutate()}>
            Run dry-run
          </Button>
        </Group>

        {dryRun.isError ? (
          <Alert tone="error" title="Dry-run failed">
            {dryRun.error instanceof ApiError ? dryRun.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        {plan ? (
          <Stack gap="sm">
            <Divider />
            <Group gap="sm">
              <StatusBadge tone={planTone(plan.status)}>{plan.status}</StatusBadge>
              <Text size="sm">
                <Code>{plan.currentFrontendVersion}</Code> → <Code>{plan.targetFrontendVersion ?? '—'}</Code>
              </Text>
            </Group>
            {plan.reasons.length > 0 ? (
              <List size="sm" spacing={4}>
                {plan.reasons.map((r) => (
                  <List.Item key={r}>{r}</List.Item>
                ))}
              </List>
            ) : null}
            {plan.steps.length > 0 ? (
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  Planned steps:
                </Text>
                <List size="sm" spacing={2} type="ordered">
                  {plan.steps.map((s) => (
                    <List.Item key={s}>{s}</List.Item>
                  ))}
                </List>
              </Stack>
            ) : null}
          </Stack>
        ) : null}

        {execute.isError ? (
          <Alert tone="error" title="Could not start the frontend update">
            {execute.error instanceof ApiError ? execute.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="sm">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canExecute} loading={execute.isPending} onClick={() => execute.mutate()}>
            Update frontend
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
