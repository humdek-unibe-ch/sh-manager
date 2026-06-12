// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Create-instance dialog. Reuses the same install path as the bootstrap wizard
 * (plan + install + provision) through the job layer: the BFF answers
 * `202 { operationId }` and the caller watches the journaled log. The generated
 * admin password never reaches the browser — provisioning writes it to a
 * root-readable file on the server and the operation result shows that path.
 */
import { useState } from 'react';
import { Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Checkbox, SelectField, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { CreateInstanceRequest } from '../../lib/types';

export interface CreateInstanceFormProps {
  client: ApiClient;
  opened: boolean;
  onClose: () => void;
  /** Prefill for the registry URL (from the server snapshot config). */
  defaultRegistryUrl: string;
  /** Called with the started operation id (202 semantics). */
  onStarted: (operationId: string) => void;
}

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function CreateInstanceForm({
  client,
  opened,
  onClose,
  defaultRegistryUrl,
  onStarted,
}: CreateInstanceFormProps): JSX.Element {
  const [instanceId, setInstanceId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [mode, setMode] = useState<'local' | 'production'>('production');
  const [domain, setDomain] = useState('');
  const [localPort, setLocalPort] = useState('9100');
  const [version, setVersion] = useState('');
  const [useTestChannel, setUseTestChannel] = useState(false);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');

  const idError =
    instanceId !== '' && !INSTANCE_ID_RE.test(instanceId)
      ? 'Lowercase letters, digits and dashes only (must start alphanumeric).'
      : undefined;
  const portError =
    mode === 'local' && localPort !== '' && !/^\d+$/.test(localPort) ? 'Port must be a number.' : undefined;
  const ready =
    instanceId !== '' &&
    !idError &&
    displayName !== '' &&
    adminEmail.includes('@') &&
    (mode === 'production' ? domain !== '' : localPort !== '' && !portError);

  const start = useMutation({
    mutationFn: (req: CreateInstanceRequest) => client.createInstance(req),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  function submit(): void {
    const req: CreateInstanceRequest = {
      instanceId,
      displayName,
      mode,
      registryUrl: defaultRegistryUrl,
      adminEmail,
      ...(mode === 'production' ? { domain } : { localPort: Number(localPort) }),
      ...(version.trim() !== '' ? { version: version.trim() } : {}),
      ...(useTestChannel ? { channel: 'test' } : {}),
      ...(adminName.trim() !== '' ? { adminName: adminName.trim() } : {}),
    };
    start.mutate(req);
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Create a new instance" size="lg" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          The manager installs the latest published release, provisions the database and creates the first
          admin account. The generated admin password is written to a restricted file on the server — it is
          never shown here.
        </Text>

        <Group grow align="flex-start">
          <TextField
            label="Instance id"
            value={instanceId}
            onChange={(v) => setInstanceId(v.toLowerCase())}
            required
            placeholder="website1"
            {...(idError ? { error: idError } : {})}
          />
          <TextField label="Display name" value={displayName} onChange={setDisplayName} required placeholder="My site" />
        </Group>

        <SelectField
          label="Mode"
          value={mode}
          onChange={(v) => setMode(v === 'local' ? 'local' : 'production')}
          options={[
            { value: 'production', label: 'Production (domain + TLS via the shared proxy)' },
            { value: 'local', label: 'Local (bound to a localhost port)' },
          ]}
        />
        {mode === 'production' ? (
          <TextField label="Domain" value={domain} onChange={setDomain} required placeholder="site.example.org" />
        ) : (
          <TextField
            label="Local port"
            value={localPort}
            onChange={setLocalPort}
            required
            inputMode="numeric"
            {...(portError ? { error: portError } : {})}
          />
        )}

        <Group grow align="flex-start">
          <TextField label="Admin email" value={adminEmail} onChange={setAdminEmail} required type="email" />
          <TextField label="Admin name" value={adminName} onChange={setAdminName} placeholder="Optional" />
        </Group>

        <Group grow align="flex-start">
          <TextField
            label="Version"
            value={version}
            onChange={setVersion}
            placeholder="latest"
            help="Leave empty to install the newest published release."
          />
        </Group>
        <Checkbox checked={useTestChannel} onChange={setUseTestChannel}>
          Use the test channel (pre-release builds)
        </Checkbox>

        {start.isError ? (
          <Alert tone="error" title="Could not start the install">
            {start.error instanceof ApiError ? start.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="sm">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} loading={start.isPending} onClick={submit}>
            Create instance
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
