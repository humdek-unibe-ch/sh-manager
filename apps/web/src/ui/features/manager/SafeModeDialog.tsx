// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Safe-mode toggle dialog.
 *
 * Safe mode makes the backend boot with core bundles only (plugins disabled).
 * It is the one toggle that revives a backend crash-looping on a half-removed
 * plugin, because it works even when the PHP console is unbootable (the manager
 * writes/removes the marker file directly). The dialog deliberately offers BOTH
 * directions so the operator chooses: enable to stop the crash loop, disable to
 * bring plugins back once the underlying issue is fixed.
 *
 * Journaled operation; the parent watches the returned operation id.
 */
import { Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';

export interface SafeModeDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function SafeModeDialog({
  client,
  instanceId,
  opened,
  onClose,
  onStarted,
}: SafeModeDialogProps): JSX.Element {
  const start = useMutation({
    mutationFn: (enable: boolean) => client.setSafeMode(instanceId, { enable }),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={`Safe mode — ${instanceId}`} centered>
      <Stack gap="md">
        <Text>
          Safe mode boots <strong>{instanceId}</strong> with core bundles only, so plugins are not
          loaded. Use it to bring a backend back up when it crash-loops after a half-removed plugin
          (<Text span ff="monospace">Class &quot;…Bundle&quot; not found</Text>). Disable it again once the
          plugin issue is resolved so plugins load on the next boot.
        </Text>

        <Text size="sm" c="dimmed">
          To finalize a stuck uninstall and verify a clean boot in one step, use{' '}
          <strong>Plugin recover</strong> instead.
        </Text>

        {start.isError ? (
          <Alert tone="error" title="Could not change safe mode">
            {start.error instanceof ApiError ? start.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="sm">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            loading={start.isPending && !start.variables}
            disabled={start.isPending}
            onClick={() => start.mutate(false)}
          >
            Disable safe mode
          </Button>
          <Button
            variant="primary"
            loading={start.isPending && start.variables}
            disabled={start.isPending}
            onClick={() => start.mutate(true)}
          >
            Enable safe mode
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
