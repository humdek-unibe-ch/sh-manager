// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Outbound-email dialog: shows the current (redacted) SMTP target broken down
 * for the operator, offers a one-click passwordless campus-relay example, and
 * applies a DSN through the journaled BFF job. All against the in-memory fake
 * ApiClient.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, userEvent } from '../../test/render';
import { MailerDialog } from './MailerDialog';
import { makeFakeClient } from '../../test/fake-client';

describe('MailerDialog', () => {
  it('shows the current SMTP host/port broken out from the redacted DSN', async () => {
    const client = makeFakeClient({
      mailers: { 'clinic-a': { configured: true, redactedDsn: 'smtp://***@smtp.gmail.com:587?encryption=tls' } },
    });
    render(<MailerDialog client={client} instanceId="clinic-a" opened onClose={() => {}} onStarted={vi.fn()} />);

    expect(await screen.findByText('smtp.gmail.com')).toBeInTheDocument();
    expect(screen.getByText('587')).toBeInTheDocument();
    // The redacted DSN must never leak credentials.
    expect(screen.queryByText(/zlgwufruwqongaju/)).not.toBeInTheDocument();
  });

  it('fills a passwordless relay DSN from the example and applies it', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const setSpy = vi.spyOn(client, 'setMailer');
    const onStarted = vi.fn();
    render(<MailerDialog client={client} instanceId="clinic-a" opened onClose={() => {}} onStarted={onStarted} />);

    await user.click(await screen.findByRole('button', { name: /Use this example/i }));
    await user.click(screen.getByRole('button', { name: /Apply & restart/i }));

    await waitFor(() => expect(setSpy).toHaveBeenCalledWith('clinic-a', { dsn: 'smtp://smtp.unibe.ch:25' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });
});
