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
import { Code, Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { MAILER_DSN_RE } from '../../../instance-validation';

export interface MailerDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
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
      ? 'Use a DSN like smtp://user:pass@mail.example.org:587.'
      : undefined;

  const start = useMutation({
    mutationFn: (req: { dsn?: string; clear?: boolean }) => client.setMailer(instanceId, req),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={`Outbound email of ${instanceId}`} size="lg" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {current.data?.configured ? (
            <>
              Currently sending through <Code>{current.data.redactedDsn}</Code> (credentials hidden).
            </>
          ) : (
            <>
              Currently using the bundled <Code>Mailpit</Code> test mailbox — mail never leaves the server.
              Configure a real SMTP server for production use.
            </>
          )}
        </Text>

        <TextField
          label="SMTP DSN"
          value={dsn}
          onChange={setDsn}
          placeholder="smtp://user:pass@mail.example.org:587"
          help="Symfony Mailer DSN. The value is stored in the instance's restricted secrets file and never displayed back in full."
          {...(dsnError ? { error: dsnError } : {})}
        />

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
