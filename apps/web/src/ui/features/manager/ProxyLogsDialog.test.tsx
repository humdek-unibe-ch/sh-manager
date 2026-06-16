// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Reverse-proxy (Traefik) log viewer: reads the shared edge proxy's recent
 * (server-redacted) logs on demand so an operator can diagnose a 404 / missing
 * certificate from the GUI. All against the in-memory fake ApiClient — never a
 * real BFF or Docker.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, userEvent } from '../../test/render';
import { ProxyLogsDialog } from './ProxyLogsDialog';
import { makeFakeClient } from '../../test/fake-client';

describe('ProxyLogsDialog', () => {
  it('shows the proxy logs when opened', async () => {
    const client = makeFakeClient({
      proxyLogs: 'traefik  | level=error msg="no router found for host"\n',
    });
    render(<ProxyLogsDialog client={client} opened onClose={() => {}} />);

    expect(await screen.findByText(/no router found for host/)).toBeInTheDocument();
  });

  it('filters the visible log lines by the operator-typed substring', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({
      proxyLogs:
        'traefik  | level=info msg="Configuration loaded"\n' +
        'traefik  | level=error msg="acme: unable to obtain certificate"\n' +
        'traefik  | level=info msg="Server now listening"\n',
    });
    render(<ProxyLogsDialog client={client} opened onClose={() => {}} />);

    expect(await screen.findByText(/Server now listening/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Filter'), 'acme');

    expect(screen.getByText(/unable to obtain certificate/)).toBeInTheDocument();
    expect(screen.queryByText(/Server now listening/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Configuration loaded/)).not.toBeInTheDocument();
  });

  it('shows a start-the-proxy hint when there is no output yet', async () => {
    const client = makeFakeClient({ proxyLogs: '' });
    render(<ProxyLogsDialog client={client} opened onClose={() => {}} />);

    expect(await screen.findByText(/No log output/i)).toBeInTheDocument();
    expect(screen.getByText(/server start/i)).toBeInTheDocument();
  });
});
