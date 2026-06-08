// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OperationsConsole } from './OperationsConsole';
import { makeFakeClient } from '../../test/fake-client';

describe('OperationsConsole', () => {
  it('shows live environment status and CLI-only instance management', async () => {
    render(<OperationsConsole client={makeFakeClient()} />);

    expect(await screen.findByText('Server operations')).toBeInTheDocument();
    expect(screen.getByText('Environment status')).toBeInTheDocument();
    expect(screen.getByText(/Instance management runs on the server/i)).toBeInTheDocument();
    expect(screen.getByText(/sh-manager backup create/i)).toBeInTheDocument();
  });

  it('runs a check and reflects the passed status', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    await screen.findByText('Server operations');
    await user.click(screen.getByRole('button', { name: /Run Docker engine & Compose check/i }));

    expect((await screen.findAllByText(/passed/i)).length).toBeGreaterThan(0);
  });
});
