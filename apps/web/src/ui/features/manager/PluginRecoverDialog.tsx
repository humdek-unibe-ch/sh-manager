// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Plugin-recovery confirmation dialog.
 *
 * Recovers a backend that crash-loops after a half-removed plugin
 * (`Class "...Bundle" not found` — typically an uninstall interrupted by a
 * concurrent manager update). The recovery boots the instance in safe mode,
 * finalizes the pending uninstall, repairs the bundle registration from the
 * database, then probes a clean (plugins-on) boot. If it still fatals, safe mode
 * is left on so the instance stays up and the operator is told the next step.
 *
 * Journaled operation; the parent watches the returned operation id.
 */
import { List, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';

export interface PluginRecoverDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function PluginRecoverDialog({
  client,
  instanceId,
  opened,
  onClose,
  onStarted,
}: PluginRecoverDialogProps): JSX.Element {
  const start = useMutation({
    mutationFn: () => client.pluginRecover(instanceId),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={`Plugin recover — ${instanceId}`} centered>
      <Stack gap="md">
        <Text>
          Use this when <strong>{instanceId}</strong>&apos;s backend crash-loops with{' '}
          <Text span ff="monospace">Class &quot;…Bundle&quot; not found</Text> — usually a plugin
          uninstall that was interrupted (for example by a concurrent manager update). The recovery:
        </Text>

        <List size="sm" spacing={4}>
          <List.Item>Boots the backend in safe mode (plugins off) so it stops crashing.</List.Item>
          <List.Item>Finalizes the pending plugin uninstall and repairs the bundle list from the database.</List.Item>
          <List.Item>Verifies a clean boot with plugins enabled; if it still fails, safe mode is kept on so the site stays up.</List.Item>
        </List>

        <Text size="sm" c="dimmed">
          No data is deleted. Watch the live log for the outcome and any follow-up step.
        </Text>

        {start.isError ? (
          <Alert tone="error" title="Could not start plugin recovery">
            {start.error instanceof ApiError ? start.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Stack gap="sm">
          <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
            Recover plugins
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
}
