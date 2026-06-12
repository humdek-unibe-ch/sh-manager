// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Update dialog: dry-run first, execute second.
 *
 * The dry-run is a pure read (the BFF answers with the resolved plan, nothing
 * mutates). Execution goes through the job layer (202 + journaled log) and is
 * only enabled after a dry-run for the same inputs so the operator has seen
 * the plan, its reasons and any migration risk before committing.
 */
import { useState } from 'react';
import { Code, Divider, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import type { UpdatePlan } from '@shm/core';
import { Alert, Button, Checkbox, StatusBadge, TextField, type BadgeTone } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { UpdateInstanceRequest } from '../../lib/types';

function planTone(status: UpdatePlan['status']): BadgeTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'up_to_date':
      return 'neutral';
    case 'blocked':
      return 'error';
    default:
      return 'warning';
  }
}

/** Execution mirrors the CLI gate: blocked / up-to-date plans never execute. */
function isExecutable(plan: UpdatePlan): boolean {
  return plan.status !== 'blocked' && plan.status !== 'up_to_date' && plan.core !== null;
}

export interface InstanceUpdateDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function InstanceUpdateDialog({
  client,
  instanceId,
  opened,
  onClose,
  onStarted,
}: InstanceUpdateDialogProps): JSX.Element {
  const [target, setTarget] = useState('');
  const [useTestChannel, setUseTestChannel] = useState(false);
  const [acceptMigrationRisk, setAcceptMigrationRisk] = useState(false);
  const [approveMysqlMajor, setApproveMysqlMajor] = useState(false);
  const [plan, setPlan] = useState<UpdatePlan | null>(null);

  function requestBody(): UpdateInstanceRequest {
    return {
      ...(target.trim() !== '' ? { target: target.trim() } : {}),
      ...(useTestChannel ? { channel: 'test' } : {}),
    };
  }

  const dryRun = useMutation({
    mutationFn: () => client.updateDryRun(instanceId, requestBody()),
    onSuccess: (res) => setPlan(res.plan as UpdatePlan),
  });

  const execute = useMutation({
    mutationFn: () =>
      client.executeUpdate(instanceId, { ...requestBody(), acceptMigrationRisk, approveMysqlMajor }),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  function resetPlan(): void {
    setPlan(null);
    setAcceptMigrationRisk(false);
    setApproveMysqlMajor(false);
  }

  // The dry-run plan carries the MySQL major-upgrade decision; when the target
  // core's policy demands approval, execution stays disabled until the
  // operator explicitly opts in (mirrors the CLI's --approve-mysql-major).
  const mysqlNeedsApproval = plan?.mysqlMajor?.requiresApproval === true;
  const canExecute = plan !== null && isExecutable(plan) && !execute.isPending;

  return (
    <Modal opened={opened} onClose={onClose} title={`Update ${instanceId}`} size="lg" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Run the dry-run first: it resolves the target release, verifies signatures, evaluates plugin
          compatibility and preflight resources — without touching the instance. A pre-update backup is taken
          automatically during execution.
        </Text>

        <Group grow align="flex-end">
          <TextField
            label="Target version"
            value={target}
            onChange={(v) => {
              setTarget(v);
              resetPlan();
            }}
            placeholder="latest"
            help="Leave empty for the newest release in the channel."
          />
        </Group>
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
                <Code>{plan.currentVersion}</Code> → <Code>{plan.targetVersion ?? '—'}</Code>
              </Text>
            </Group>
            {plan.reasons.length > 0 ? (
              <List size="sm" spacing={4}>
                {plan.reasons.map((r) => (
                  <List.Item key={r}>{r}</List.Item>
                ))}
              </List>
            ) : null}
            {plan.pluginEvaluations.length > 0 ? (
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  Installed plugins against the target core:
                </Text>
                {plan.pluginEvaluations.map((p) => (
                  <Group key={p.pluginId} gap="xs" wrap="nowrap" align="flex-start">
                    <StatusBadge tone={p.blocked ? 'error' : 'ok'} dot={false}>
                      {p.blocked ? 'blocked' : 'ok'}
                    </StatusBadge>
                    <Text size="sm">
                      {p.pluginId} @ {p.installedVersion}
                      {p.blocked && p.message ? ` — ${p.message}` : ''}
                    </Text>
                  </Group>
                ))}
              </Stack>
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

            {isExecutable(plan) ? (
              <>
                <Alert tone="warning" title="Database migrations may run">
                  The update executes Doctrine migrations after the new images start. Automatic rollback exists
                  only before migrations run — afterwards, recovery is restoring the automatic pre-update
                  backup.
                </Alert>
                <Checkbox checked={acceptMigrationRisk} onChange={setAcceptMigrationRisk}>
                  I understand the migration risk and want to execute this update.
                </Checkbox>
                {mysqlNeedsApproval ? (
                  <>
                    <Alert tone="error" title="MySQL major upgrade — one-way">
                      This release upgrades MySQL{' '}
                      {plan.mysqlMajor?.fromMajor ?? '?'} → {plan.mysqlMajor?.toMajor ?? '?'}. The data volume
                      is preserved, but a major MySQL upgrade cannot be rolled back in place — recovery is
                      restoring the automatic pre-update backup. Verify a recent backup before approving.
                    </Alert>
                    <Checkbox checked={approveMysqlMajor} onChange={setApproveMysqlMajor}>
                      Approve the one-way MySQL major upgrade.
                    </Checkbox>
                  </>
                ) : null}
              </>
            ) : null}
          </Stack>
        ) : null}

        {execute.isError ? (
          <Alert tone="error" title="Could not start the update">
            {execute.error instanceof ApiError ? execute.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="sm">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!canExecute || !acceptMigrationRisk || (mysqlNeedsApproval && !approveMysqlMajor)}
            loading={execute.isPending}
            onClick={() => execute.mutate()}
          >
            Execute update
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
