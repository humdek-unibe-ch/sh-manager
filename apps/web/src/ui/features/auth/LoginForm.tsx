// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { useState } from 'react';
import { Alert, Button, Field, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';

export interface LoginFormProps {
  client: ApiClient;
  onSuccess: () => void;
}

export function LoginForm({ client, onSuccess }: LoginFormProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await client.login(email, password);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shm-center">
      <form
        className="shm-auth shm-card shm-card--pad shm-card--raised shm-stack shm-stack--4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <h1 className="shm-card__title" style={{ fontSize: '1.2rem' }}>
            Sign in to SelfHelp Manager
          </h1>
          <p className="shm-muted" style={{ fontSize: '0.9rem', marginTop: 4 }}>
            Operator access for this server.
          </p>
        </div>

        {error ? (
          <Alert tone="error" title="Sign-in failed">
            {error}
          </Alert>
        ) : null}

        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          placeholder="operator@university.edu"
          required
        />
        <Field label="Password">
          {({ id, describedBy }) => (
            <input
              id={id}
              className="shm-input"
              type="password"
              value={password}
              autoComplete="current-password"
              aria-describedby={describedBy}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" block loading={busy} disabled={!email || !password}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
