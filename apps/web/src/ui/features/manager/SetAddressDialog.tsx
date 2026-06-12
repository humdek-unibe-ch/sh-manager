// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Change where an instance is reachable, directly from the manager:
 * - production instances move to a NEW DOMAIN (Traefik routing + TLS
 *   certificate + Mercure route are regenerated);
 * - local instances move to a NEW LOCALHOST PORT.
 *
 * The instance restarts automatically to apply the new address (the BFF runs
 * `instance set-address` through the job layer: 202 + journaled log). DNS for
 * a production domain must already point at this server — the operation warns
 * (or blocks nothing) but the certificate can only be issued once DNS is live.
 */
import { useEffect, useState } from 'react';
import { Code, Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { HOSTNAME_RE, isValidLocalPort } from '../../../instance-validation';
import type { SetAddressRequest } from '../../lib/types';

export interface SetAddressDialogProps {
  client: ApiClient;
  instanceId: string;
  /** Instance mode decides which address is edited (null falls back to production). */
  mode: 'local' | 'production' | null;
  /** Current address shown for reference (domain or `localhost:port`). */
  currentAddress: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

export function SetAddressDialog({
  client,
  instanceId,
  mode,
  currentAddress,
  opened,
  onClose,
  onStarted,
}: SetAddressDialogProps): JSX.Element {
  const effectiveMode: 'local' | 'production' = mode === 'local' ? 'local' : 'production';
  const [domain, setDomain] = useState('');
  const [localPort, setLocalPort] = useState('');

  // Prefill with the current address every time the dialog opens.
  useEffect(() => {
    if (!opened) return;
    if (effectiveMode === 'local') {
      const port = /:(\d+)$/.exec(currentAddress)?.[1] ?? '';
      setLocalPort(port);
      setDomain('');
    } else {
      setDomain(currentAddress);
      setLocalPort('');
    }
  }, [opened, effectiveMode, currentAddress]);

  const domainError =
    domain !== '' && !HOSTNAME_RE.test(domain)
      ? 'Enter a bare hostname, e.g. site.example.org (no scheme, no slash).'
      : undefined;
  const portNumber = Number(localPort);
  const portError =
    localPort !== '' && !isValidLocalPort(portNumber) ? 'Port must be a number between 1024 and 65535.' : undefined;
  const ready = effectiveMode === 'production' ? domain !== '' && !domainError : localPort !== '' && !portError;

  const start = useMutation({
    mutationFn: (req: SetAddressRequest) => client.setInstanceAddress(instanceId, req),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={`Change address of ${instanceId}`} size="lg" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Currently reachable at <Code>{currentAddress || '—'}</Code>. The manager rewrites the instance
          configuration and routing for the new address — versions, data and secrets stay untouched.
        </Text>

        {effectiveMode === 'production' ? (
          <>
            <TextField
              label="New domain"
              value={domain}
              onChange={setDomain}
              required
              placeholder="site.example.org"
              help="Point the DNS A/AAAA record of this hostname at this server FIRST — the TLS certificate is requested automatically once traffic arrives."
              {...(domainError ? { error: domainError } : {})}
            />
            <Alert tone="warning" title="DNS checklist">
              Create or update the DNS record for the new domain before applying. The old domain stops being
              routed as soon as the change is applied.
            </Alert>
          </>
        ) : (
          <TextField
            label="New local port"
            value={localPort}
            onChange={setLocalPort}
            required
            inputMode="numeric"
            help="Published on 127.0.0.1 only. Pick a free port between 1024 and 65535."
            {...(portError ? { error: portError } : {})}
          />
        )}

        <Alert tone="info" title="The instance restarts automatically">
          Applying the change recreates the containers with the new address — expect roughly a minute of
          downtime while they come back up.
        </Alert>

        {start.isError ? (
          <Alert tone="error" title="Could not change the address">
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
              start.mutate(effectiveMode === 'production' ? { domain } : { localPort: portNumber })
            }
          >
            Apply & restart
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
