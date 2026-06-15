// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Configure how an instance sends outbound email (password resets,
 * notifications): set a real SMTP DSN or clear it to fall back to the bundled
 * Mailpit test mailbox. The DSN is stored in the instance's restricted
 * secrets file (it may carry SMTP credentials) and only a credential-redacted
 * form is ever shown. Applying the change restarts the instance (BFF job
 * layer: 202 + journaled log).
 */
import { useEffect, useState } from 'react';
import { Anchor, Code, Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, KeyValue, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { MAILER_DSN_RE } from '../../../instance-validation';

export interface MailerDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

/** A passwordless relay example operators can fill in with one click. */
const PASSWORDLESS_EXAMPLE = 'smtp://smtp.unibe.ch:25';

/**
 * Best-effort, display-only breakdown of a (redacted) SMTP DSN so the operator
 * can see the current host/port/auth at a glance. Never used to send anything —
 * the server keeps the authoritative (unredacted) value in the secrets file.
 */
function describeDsn(redactedDsn: string): { host: string; port: string; auth: 'yes' | 'no'; encryption: string } | null {
  try {
    const url = new URL(redactedDsn);
    return {
      host: url.hostname || '—',
      port: url.port || '(default)',
      auth: redactedDsn.includes('***@') ? 'yes' : 'no',
      encryption: url.searchParams.get('encryption') ?? '(opportunistic)',
    };
  } catch {
    return null;
  }
}

export function MailerDialog({ client, instanceId, opened, onClose, onStarted }: MailerDialogProps): JSX.Element {
  const [dsn, setDsn] = useState('');

  const current = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'mailer'],
    queryFn: () => client.getMailer(instanceId),
    enabled: opened,
  });

  // Fresh field every time the dialog opens.
  useEffect(() => {
    if (opened) setDsn('');
  }, [opened]);

  const dsnError =
    dsn !== '' && !MAILER_DSN_RE.test(dsn)
      ? 'Use a DSN like smtp://user:pass@mail.example.org:587 (or smtp://host:25 for a relay without authentication).'
      : undefined;

  const start = useMutation({
    mutationFn: (req: { dsn?: string; clear?: boolean }) => client.setMailer(instanceId, req),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  const parsed = current.data?.configured && current.data.redactedDsn ? describeDsn(current.data.redactedDsn) : null;

  return (
    <Modal opened={opened} onClose={onClose} title={`Outbound email of ${instanceId}`} size="lg" centered>
      <Stack gap="md">
        {current.isPending ? (
          <Text size="sm" c="dimmed">
            Loading the current mail configuration…
          </Text>
        ) : current.data?.configured ? (
          <Stack gap={6}>
            <Text size="sm" c="dimmed">
              Currently sending through <Code>{current.data.redactedDsn}</Code> (credentials hidden).
            </Text>
            {parsed ? (
              <KeyValue
                rows={[
                  { key: 'SMTP host', value: parsed.host },
                  { key: 'Port', value: parsed.port },
                  { key: 'Authentication', value: parsed.auth === 'yes' ? 'username + password' : 'none (relay)' },
                  { key: 'Encryption', value: parsed.encryption },
                ]}
              />
            ) : null}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            Currently using the bundled <Code>Mailpit</Code> test mailbox — mail never leaves the server.
            Configure a real SMTP server for production use.
          </Text>
        )}

        <TextField
          label="SMTP DSN"
          value={dsn}
          onChange={setDsn}
          placeholder="smtp://user:pass@mail.example.org:587"
          help="Symfony Mailer DSN. The value is stored in the instance's restricted secrets file and never displayed back in full."
          {...(dsnError ? { error: dsnError } : {})}
        />

        <Alert tone="info" title="Using a campus / university relay without a password">
          <Stack gap={6}>
            <Text size="sm">
              If the server sends through an SMTP relay that accepts mail from its network without
              authentication (e.g. the university mail host), leave out the username and password and just
              point at the host and port:
            </Text>
            <Group gap="sm">
              <Code>{PASSWORDLESS_EXAMPLE}</Code>
              <Anchor component="button" type="button" size="sm" onClick={() => setDsn(PASSWORDLESS_EXAMPLE)}>
                Use this example
              </Anchor>
            </Group>
            <Text size="xs" c="dimmed">
              Replace the host/port with your relay (for UniBE that is typically the internal mail host on
              port 25). No credentials are stored in this case.
            </Text>
          </Stack>
        </Alert>

        <Alert tone="info" title="The instance restarts automatically">
          Applying the change recreates the containers so all services pick up the new mail settings.
        </Alert>

        {start.isError ? (
          <Alert tone="error" title="Could not change the mail settings">
            {start.error instanceof ApiError ? start.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : null}

        <Group justify="space-between" gap="sm">
          <Button
            variant="ghost"
            disabled={current.data ? !current.data.configured : true}
            loading={start.isPending && start.variables?.clear === true}
            onClick={() => start.mutate({ clear: true })}
          >
            Reset to test mailbox
          </Button>
          <Group gap="sm">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={dsn === '' || dsnError !== undefined}
              loading={start.isPending && start.variables?.clear !== true}
              onClick={() => start.mutate({ dsn })}
            >
              Apply & restart
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
