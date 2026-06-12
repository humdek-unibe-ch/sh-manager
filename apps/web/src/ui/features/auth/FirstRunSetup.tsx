// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * First-run operator setup: shown instead of the sign-in form while NO
 * operator account exists yet. Creates the first (server_owner) operator via
 * the localhost-guarded `/api/setup/operator` endpoint and signs them in —
 * the endpoint hard-locks itself once any operator exists, so this screen can
 * never appear on a configured manager.
 */
import { useState } from 'react';
import { Center, List, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';

const MIN_PASSWORD_LENGTH = 12;

export interface FirstRunSetupProps {
  client: ApiClient;
  onSuccess: () => void;
}

export function FirstRunSetup({ client, onSuccess }: FirstRunSetupProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const setup = useMutation({
    mutationFn: () => client.setupOperator(email, password, displayName.trim() || undefined),
    onSuccess,
  });

  const tooShort = password !== '' && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm !== '' && confirm !== password;
  const ready = email !== '' && password.length >= MIN_PASSWORD_LENGTH && confirm === password;

  const error = setup.isError
    ? setup.error instanceof ApiError
      ? setup.error.message
      : 'Could not create the operator account. Please try again.'
    : null;

  return (
    <Center mih="60vh">
      <Paper
        component="form"
        withBorder
        shadow="sm"
        radius="md"
        p="xl"
        w="100%"
        maw={640}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) setup.mutate();
        }}
      >
        <Stack gap="md">
          <div>
            <Title order={3}>Welcome to SelfHelp Manager</Title>
            <Text size="sm" c="dimmed" mt={4}>
              Create the operator account you will use to sign in to this console. This screen only exists
              while no account has been created.
            </Text>
          </div>

          <Alert tone="info" title="What this account is for">
            <List size="sm" spacing={4}>
              <List.Item>Managing SelfHelp instances on this server (install, update, backup).</List.Item>
              <List.Item>It is local to this manager — it is not a SelfHelp CMS user.</List.Item>
              <List.Item>More operators can be added later via the CLI.</List.Item>
            </List>
          </Alert>

          {error ? (
            <Alert tone="error" title="Setup failed">
              {error}
            </Alert>
          ) : null}

          <TextInput
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            autoComplete="username"
            placeholder="operator@university.edu"
            required
          />
          <TextInput
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.currentTarget.value)}
            placeholder="Optional"
          />
          <PasswordInput
            label="Password"
            description={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoComplete="new-password"
            required
            {...(tooShort ? { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` } : {})}
          />
          <PasswordInput
            label="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.currentTarget.value)}
            autoComplete="new-password"
            required
            {...(mismatch ? { error: 'Passwords do not match.' } : {})}
          />

          <Button type="submit" variant="primary" block loading={setup.isPending} disabled={!ready}>
            Create account & sign in
          </Button>
        </Stack>
      </Paper>
    </Center>
  );
}
