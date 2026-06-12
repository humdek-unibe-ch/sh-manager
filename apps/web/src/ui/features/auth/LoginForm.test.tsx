// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { LoginForm } from './LoginForm';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { makeFakeClient } from '../../test/fake-client';

// The login screen only ever calls `client.login`; the other methods must not be
// reached, so they reject loudly if a test accidentally triggers them.
const fail = (): Promise<never> => Promise.reject(new Error('not used in login tests'));

function clientWithLogin(login: ApiClient['login']): ApiClient {
  // Every other ApiClient method rejects (kept exhaustive via the fake's key set).
  const failing = Object.fromEntries(Object.keys(makeFakeClient()).map((key) => [key, fail]));
  return { ...failing, login, logout: async () => {} } as unknown as ApiClient;
}

// Mantine's PasswordInput renders a visibility toggle whose aria-label contains
// "password", so the field itself must be queried by its <input> selector.
const passwordField = (): HTMLElement => screen.getByLabelText(/password/i, { selector: 'input' });

describe('LoginForm', () => {
  it('keeps the submit button disabled until both fields are filled', async () => {
    const user = userEvent.setup();
    render(
      <LoginForm
        client={clientWithLogin(async () => ({ ok: true, email: 'a@b.c', roles: [], csrfToken: 't' }))}
        onSuccess={() => {}}
      />,
    );

    expect(screen.getByText('Sign in to SelfHelp Manager')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /sign in/i });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText(/email/i), 'op@x.edu');
    expect(button).toBeDisabled();
    await user.type(passwordField(), 'secret-pw');
    expect(button).toBeEnabled();
  });

  it('signs in with the entered credentials and calls onSuccess', async () => {
    const user = userEvent.setup();
    const login = vi.fn(async () => ({ ok: true, email: 'op@x.edu', roles: ['server_owner'], csrfToken: 'tok' }));
    const onSuccess = vi.fn();
    render(<LoginForm client={clientWithLogin(login)} onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText(/email/i), 'op@x.edu');
    await user.type(passwordField(), 'secret-pw');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith('op@x.edu', 'secret-pw');
  });

  it('surfaces the API error message and does not call onSuccess on failure', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(
      <LoginForm
        client={clientWithLogin(async () => {
          throw new ApiError(401, 'Invalid email or password.');
        })}
        onSuccess={onSuccess}
      />,
    );

    await user.type(screen.getByLabelText(/email/i), 'op@x.edu');
    await user.type(passwordField(), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument();
    expect(screen.getByText('Sign-in failed')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
