// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { useState } from 'react';
import { Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';

export interface LoginFormProps {
  client: ApiClient;
  onSuccess: () => void;
}

export function LoginForm({ client, onSuccess }: LoginFormProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => client.login(email, password),
    onSuccess,
  });

  const error = login.isError
    ? login.error instanceof ApiError
      ? login.error.message
      : 'Could not sign in. Please try again.'
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
          login.mutate();
        }}
      >
        <Stack gap="md">
          <div>
            <Title order={3}>Sign in to SelfHelp Manager</Title>
            <Text size="sm" c="dimmed" mt={4}>
              Operator access for this server.
            </Text>
          </div>

          {error ? (
            <Alert tone="error" title="Sign-in failed">
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
          <PasswordInput
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoComplete="current-password"
            required
          />

          <Button type="submit" variant="primary" block loading={login.isPending} disabled={!email || !password}>
            Sign in
          </Button>
        </Stack>
      </Paper>
    </Center>
  );
}
