// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Disable / Enable confirmation dialog — the instance lifecycle toggle.
 *
 * - Disable stops the containers but keeps every volume, secret and backup, so
 *   it is fully reversible (the same `disable` the CLI performs). It still takes
 *   the site offline, so we confirm first.
 * - Enable brings a disabled (or removed-keep-data) instance back online.
 *
 * Both are journaled operations; the parent watches the returned operation id.
 */
import { Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';

export type ToggleAction = 'disable' | 'enable';

export interface ToggleEnabledDialogProps {
  client: ApiClient;
  instanceId: string;
  /** Which action to confirm, or null when the dialog is closed. */
  action: ToggleAction | null;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function ToggleEnabledDialog({
  client,
  instanceId,
  action,
  onClose,
  onStarted,
}: ToggleEnabledDialogProps): JSX.Element {
  const start = useMutation({
    mutationFn: () =>
      action === 'enable' ? client.enableInstance(instanceId) : client.disableInstance(instanceId),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  const isEnable = action === 'enable';
  const title = isEnable ? `Enable ${instanceId}` : `Disable ${instanceId}`;

  return (
    <Modal opened={action !== null} onClose={onClose} title={title} centered>
      <Stack gap="md">
        {isEnable ? (
          <Text>
            Start the containers for <strong>{instanceId}</strong> again and mark it active. All data,
            uploads, plugins and backups were kept while it was disabled, so it comes back exactly as
            it was.
          </Text>
        ) : (
          <Text>
            Stop the containers for <strong>{instanceId}</strong>. The database, uploads, plugins and
            backups are all kept — only the running containers stop, so the site goes offline until you
            enable it again. This is fully reversible.
          </Text>
        )}

        {start.isError ? (
          <Alert tone="error" title={isEnable ? 'Could not enable the instance' : 'Could not disable the instance'}>
            {start.error instanceof ApiError ? start.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="sm">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={isEnable ? 'primary' : 'danger'}
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            {isEnable ? 'Enable instance' : 'Disable instance'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
