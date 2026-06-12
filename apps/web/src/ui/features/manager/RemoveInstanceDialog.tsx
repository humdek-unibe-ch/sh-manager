// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Remove dialog with three explicit levels — there is deliberately no bare
 * "Delete" button:
 *
 * - disable: stop containers, keep everything (reversible).
 * - remove_containers_keep_data: compose down WITHOUT volumes; data + backups stay.
 * - full_delete: destructive; requires typing `delete <id>` exactly (the same
 *   confirmation the CLI requires) and explicit opt-ins for volumes/backups.
 */
import { useState } from 'react';
import { Code, Group, Modal, Radio, Stack } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Checkbox, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { RemoveInstanceRequest } from '../../lib/types';

type RemoveMode = RemoveInstanceRequest['mode'];

export interface RemoveInstanceDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function RemoveInstanceDialog({
  client,
  instanceId,
  opened,
  onClose,
  onStarted,
}: RemoveInstanceDialogProps): JSX.Element {
  const [mode, setMode] = useState<RemoveMode>('disable');
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [deleteBackups, setDeleteBackups] = useState(false);
  const [typed, setTyped] = useState('');

  const expected = `delete ${instanceId}`;
  const confirmed = mode !== 'full_delete' || typed === expected;

  const start = useMutation({
    mutationFn: () =>
      client.removeInstance(instanceId, {
        mode,
        ...(mode === 'full_delete'
          ? { deleteVolumes, deleteBackups, confirm: typed }
          : {}),
      }),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={`Remove ${instanceId}`} size="lg" centered>
      <Stack gap="md">
        <Radio.Group value={mode} onChange={(v) => setMode(v as RemoveMode)} label="What should happen?">
          <Stack gap="xs" mt="xs">
            <Radio
              value="disable"
              label="Disable — stop the containers, keep all data. Reversible at any time."
            />
            <Radio
              value="remove_containers_keep_data"
              label="Remove containers, keep data — compose down without volumes; database, uploads and backups stay."
            />
            <Radio
              value="full_delete"
              label="Full delete — remove the instance from this server. Destructive."
            />
          </Stack>
        </Radio.Group>

        {mode === 'full_delete' ? (
          <Stack gap="sm">
            <Alert tone="error" title="This cannot be undone">
              Take a backup first if you might need this instance again. Type{' '}
              <Code>{expected}</Code> to confirm.
            </Alert>
            <Checkbox checked={deleteVolumes} onChange={setDeleteVolumes}>
              Also delete the Docker volumes (database contents, uploads)
            </Checkbox>
            <Checkbox checked={deleteBackups} onChange={setDeleteBackups}>
              Also delete this instance&apos;s backups
            </Checkbox>
            <TextField label="Type the confirmation" value={typed} onChange={setTyped} placeholder={expected} />
          </Stack>
        ) : null}

        {start.isError ? (
          <Alert tone="error" title="Could not start the removal">
            {start.error instanceof ApiError ? start.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="sm">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!confirmed}
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            {mode === 'disable' ? 'Disable instance' : mode === 'full_delete' ? 'Delete instance' : 'Remove containers'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
