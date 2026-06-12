// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Clone dialog. The clone always generates FRESH secrets for the target —
 * credentials are never copied — and locks the SOURCE instance while its data
 * is read. Runs through the job layer (202 + journaled log).
 */
import { useState } from 'react';
import { Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Checkbox, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { CloneInstanceRequest } from '../../lib/types';

export interface CloneInstanceDialogProps {
  client: ApiClient;
  sourceInstanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function CloneInstanceDialog({
  client,
  sourceInstanceId,
  opened,
  onClose,
  onStarted,
}: CloneInstanceDialogProps): JSX.Element {
  const [targetId, setTargetId] = useState('');
  const [targetDomain, setTargetDomain] = useState('');
  const [useLocalPort, setUseLocalPort] = useState(false);
  const [localPort, setLocalPort] = useState('9101');

  const idError =
    targetId !== '' && !INSTANCE_ID_RE.test(targetId)
      ? 'Lowercase letters, digits and dashes only (must start alphanumeric).'
      : targetId === sourceInstanceId
        ? 'The clone needs a different instance id.'
        : undefined;
  const portError = useLocalPort && !/^\d+$/.test(localPort) ? 'Port must be a number.' : undefined;
  const ready = targetId !== '' && !idError && targetDomain !== '' && !portError;

  const start = useMutation({
    mutationFn: (req: CloneInstanceRequest) => client.cloneInstance(sourceInstanceId, req),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={`Clone ${sourceInstanceId}`} size="lg" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Creates a full copy (database, uploads, plugins) under a new instance id. The copy always gets fresh
          secrets — passwords, tokens and keys are never shared between instances.
        </Text>

        <TextField
          label="New instance id"
          value={targetId}
          onChange={(v) => setTargetId(v.toLowerCase())}
          required
          placeholder={`${sourceInstanceId}-copy`}
          {...(idError ? { error: idError } : {})}
        />
        <TextField
          label="New domain"
          value={targetDomain}
          onChange={setTargetDomain}
          required
          placeholder="staging.example.org"
        />
        <Checkbox checked={useLocalPort} onChange={setUseLocalPort}>
          Bind to a localhost port instead of the shared proxy
        </Checkbox>
        {useLocalPort ? (
          <TextField
            label="Local port"
            value={localPort}
            onChange={setLocalPort}
            required
            inputMode="numeric"
            {...(portError ? { error: portError } : {})}
          />
        ) : null}

        {start.isError ? (
          <Alert tone="error" title="Could not start the clone">
            {start.error instanceof ApiError ? start.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="sm">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={start.isPending}
            onClick={() =>
              start.mutate({
                targetInstanceId: targetId,
                targetDomain,
                ...(useLocalPort ? { targetLocalPort: Number(localPort) } : {}),
              })
            }
          >
            Clone instance
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
