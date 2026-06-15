// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Rename an instance's operator-facing DISPLAY NAME from the manager.
 *
 * Only the friendly label changes. The instanceId is the immutable technical
 * key (Compose project, directory, volumes, network, routing), so it is shown
 * read-only and never edited here — renaming it would have to recreate every
 * Docker resource. A display-name change is metadata only: the manager rewrites
 * the manifest (and the generated README), with NO container restart and no
 * data risk. This is the rename operators want after a clone or a domain change.
 */
import { useEffect, useState } from 'react';
import { Code, Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { SetNameRequest } from '../../lib/types';

export interface RenameInstanceDialogProps {
  client: ApiClient;
  instanceId: string;
  /** Current display name shown for reference / prefill. */
  currentName: string | null;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function RenameInstanceDialog({
  client,
  instanceId,
  currentName,
  opened,
  onClose,
  onStarted,
}: RenameInstanceDialogProps): JSX.Element {
  const [displayName, setDisplayName] = useState('');

  // Prefill with the current name every time the dialog opens.
  useEffect(() => {
    if (opened) setDisplayName(currentName ?? '');
  }, [opened, currentName]);

  const trimmed = displayName.trim();
  const tooLong = trimmed.length > 200;
  const nameError = tooLong ? 'Display name is too long (max 200 characters).' : undefined;
  const ready = trimmed !== '' && !tooLong;

  const start = useMutation({
    mutationFn: (req: SetNameRequest) => client.setInstanceName(instanceId, req),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={`Rename ${instanceId}`} size="md" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Change the friendly display name only. The technical id stays{' '}
          <Code>{instanceId}</Code> — it names the containers, volumes and routing and cannot be changed.
        </Text>

        <TextField
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          required
          placeholder="e.g. Clinic A (production)"
          help="Shown in the manager lists and on this instance's page. Purely cosmetic."
          {...(nameError ? { error: nameError } : {})}
        />

        <Alert tone="info" title="No restart, no downtime">
          Renaming only updates the instance metadata. Containers keep running and no data is touched.
        </Alert>

        {start.isError ? (
          <Alert tone="error" title="Could not rename the instance">
            {start.error instanceof ApiError ? start.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="sm">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} loading={start.isPending} onClick={() => start.mutate({ displayName: trimmed })}>
            Rename
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
