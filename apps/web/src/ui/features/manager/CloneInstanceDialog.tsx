// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Clone dialog. The clone always generates FRESH secrets for the target —
 * credentials are never copied — and locks the SOURCE instance while its data
 * is read. Runs through the job layer (202 + journaled log).
 *
 * The target address follows the SOURCE's mode: production sources are cloned
 * onto a new domain, local (port-published) sources onto a new localhost
 * port — same rule the server and CLI enforce.
 */
import { useState } from 'react';
import { Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { HOSTNAME_RE, INSTANCE_ID_RE, isValidLocalPort } from '../../../instance-validation';
import type { CloneInstanceRequest } from '../../lib/types';

export interface CloneInstanceDialogProps {
  client: ApiClient;
  sourceInstanceId: string;
  /** Mode of the SOURCE instance — decides whether the clone needs a domain or a port. */
  sourceMode: 'local' | 'production' | null;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function CloneInstanceDialog({
  client,
  sourceInstanceId,
  sourceMode,
  opened,
  onClose,
  onStarted,
}: CloneInstanceDialogProps): JSX.Element {
  const effectiveMode: 'local' | 'production' = sourceMode === 'local' ? 'local' : 'production';
  const [targetId, setTargetId] = useState('');
  const [targetDomain, setTargetDomain] = useState('');
  const [localPort, setLocalPort] = useState('');

  const idError =
    targetId !== '' && !INSTANCE_ID_RE.test(targetId)
      ? 'Lowercase letters, digits and dashes only (must start alphanumeric).'
      : targetId === sourceInstanceId
        ? 'The clone needs a different instance id.'
        : undefined;
  const domainError =
    targetDomain !== '' && !HOSTNAME_RE.test(targetDomain)
      ? 'Enter a bare hostname, e.g. staging.example.org (no scheme, no slash).'
      : undefined;
  const portNumber = Number(localPort);
  const portError =
    localPort !== '' && !isValidLocalPort(portNumber) ? 'Port must be a number between 1024 and 65535.' : undefined;

  const ready =
    targetId !== '' &&
    !idError &&
    (effectiveMode === 'production' ? targetDomain !== '' && !domainError : localPort !== '' && !portError);

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

        {effectiveMode === 'production' ? (
          <TextField
            label="New domain"
            value={targetDomain}
            onChange={setTargetDomain}
            required
            placeholder="staging.example.org"
            help="The clone is routed on its own domain — point its DNS record at this server."
            {...(domainError ? { error: domainError } : {})}
          />
        ) : (
          <TextField
            label="New local port"
            value={localPort}
            onChange={setLocalPort}
            required
            inputMode="numeric"
            placeholder="9101"
            help="The clone is published on its own 127.0.0.1 port."
            {...(portError ? { error: portError } : {})}
          />
        )}

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
                ...(effectiveMode === 'production' ? { targetDomain } : { targetLocalPort: portNumber }),
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
