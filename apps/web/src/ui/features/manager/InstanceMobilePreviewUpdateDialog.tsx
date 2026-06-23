// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Mobile-preview-only update dialog: dry-run first, execute second.
 *
 * The optional `selfhelp-mobile-preview` container ships independently of the
 * core (on the mobile repo's own tags), so an instance already on the latest
 * core can still have a newer preview. This is the lightweight path: the dry-run
 * resolves the newest compatible preview AND runs the dual-axis plugin↔preview
 * gate (native / not_bundled / incompatible / web_only), and execution swaps
 * ONLY the preview container — no database migration, no full backup, no
 * maintenance window, because the preview is stateless. The core stack and every
 * volume stay untouched.
 */
import { useState } from 'react';
import { Code, Divider, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import type { MobilePreviewUpdatePlan } from '@shm/core';
import { Alert, Button, Checkbox, StatusBadge, type BadgeTone } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { MobilePreviewUpdateInstanceRequest } from '../../lib/types';
import { VersionSelect } from './VersionSelect';

/**
 * One installed-plugin verdict the dry-run appends to the plan. Mirrors the
 * resolver's `MobilePluginEvaluation` (kept local so the UI does not depend on
 * the resolver package directly).
 */
interface PluginGateEvaluation {
  pluginId: string;
  verdict: 'native' | 'not_bundled' | 'incompatible' | 'web_only';
  message: string;
}

/** The dry-run plan plus the appended dual-axis plugin gate (see adapter). */
type MobilePreviewDryRunPlan = MobilePreviewUpdatePlan & {
  pluginGate: { status: string; evaluations: PluginGateEvaluation[] } | null;
};

function planTone(status: MobilePreviewUpdatePlan['status']): BadgeTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'up_to_date':
      return 'neutral';
    default:
      return 'error';
  }
}

function verdictTone(verdict: PluginGateEvaluation['verdict']): BadgeTone {
  switch (verdict) {
    case 'native':
      return 'ok';
    case 'incompatible':
      return 'error';
    case 'not_bundled':
      return 'warning';
    default:
      // web_only is informational: the plugin opens on the web frontend.
      return 'neutral';
  }
}

function isExecutable(plan: MobilePreviewDryRunPlan): boolean {
  // A native-renderer incompatibility blocks the swap (the operator must update
  // or remove the plugin, or pick another preview).
  if (plan.pluginGate?.status === 'blocked') return false;
  return plan.status === 'ok' && plan.mobilePreview !== null;
}

export interface InstanceMobilePreviewUpdateDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function InstanceMobilePreviewUpdateDialog({
  client,
  instanceId,
  opened,
  onClose,
  onStarted,
}: InstanceMobilePreviewUpdateDialogProps): JSX.Element {
  return (
    <Modal opened={opened} onClose={onClose} title={`Update mobile preview — ${instanceId}`} size="lg" centered>
      <InstanceMobilePreviewUpdateBody client={client} instanceId={instanceId} onClose={onClose} onStarted={onStarted} />
    </Modal>
  );
}

export interface InstanceMobilePreviewUpdateBodyProps {
  client: ApiClient;
  instanceId: string;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

/**
 * The mobile-preview-only update form without the surrounding Modal. Keeps the
 * current core + frontend and swaps only the stateless preview container.
 */
export function InstanceMobilePreviewUpdateBody({
  client,
  instanceId,
  onClose,
  onStarted,
}: InstanceMobilePreviewUpdateBodyProps): JSX.Element {
  const [target, setTarget] = useState('');
  const [useTestChannel, setUseTestChannel] = useState(false);
  const [plan, setPlan] = useState<MobilePreviewDryRunPlan | null>(null);

  function requestBody(): MobilePreviewUpdateInstanceRequest {
    return {
      ...(target.trim() !== '' ? { target: target.trim() } : {}),
      ...(useTestChannel ? { channel: 'test' } : {}),
    };
  }

  const dryRun = useMutation({
    mutationFn: () => client.mobilePreviewUpdateDryRun(instanceId, requestBody()),
    onSuccess: (res) => setPlan(res.plan as MobilePreviewDryRunPlan),
  });

  const execute = useMutation({
    mutationFn: () => client.executeMobilePreviewUpdate(instanceId, requestBody()),
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
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        The mobile preview is released independently of the core. This swaps only the preview container to a
        newer compatible release — no database migration, no maintenance window, and all data is left untouched.
        Run the dry-run first to resolve the target and check installed-plugin compatibility.
      </Text>

      <VersionSelect
        client={client}
        kind="mobile-preview"
        label="Target mobile-preview version"
        {...(useTestChannel ? { channel: 'test' } : {})}
        value={target === '' ? 'latest' : target}
        onChange={(v) => {
          setTarget(v === 'latest' ? '' : v);
          resetPlan();
        }}
        help='Versions come from the verified release registry — "latest" resolves to the newest compatible preview in the channel.'
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
              <Code>{plan.currentMobilePreviewVersion}</Code> → <Code>{plan.targetMobilePreviewVersion ?? '—'}</Code>
            </Text>
          </Group>
          {plan.reasons.length > 0 ? (
            <List size="sm" spacing={4}>
              {plan.reasons.map((r) => (
                <List.Item key={r}>{r}</List.Item>
              ))}
            </List>
          ) : null}

          {plan.pluginGate && plan.pluginGate.evaluations.length > 0 ? (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Installed-plugin compatibility:
              </Text>
              <List size="sm" spacing={4}>
                {plan.pluginGate.evaluations.map((ev) => (
                  <List.Item
                    key={ev.pluginId}
                    icon={<StatusBadge tone={verdictTone(ev.verdict)}>{ev.verdict}</StatusBadge>}
                  >
                    <Text size="sm">
                      <Code>{ev.pluginId}</Code> — {ev.message}
                    </Text>
                  </List.Item>
                ))}
              </List>
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
        </Stack>
      ) : null}

      {execute.isError ? (
        <Alert tone="error" title="Could not start the mobile preview update">
          {execute.error instanceof ApiError ? execute.error.message : 'The manager service did not answer.'}
        </Alert>
      ) : null}

      <Group justify="flex-end" gap="sm">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canExecute} loading={execute.isPending} onClick={() => execute.mutate()}>
          Update mobile preview
        </Button>
      </Group>
    </Stack>
  );
}
