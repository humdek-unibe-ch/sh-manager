// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Dialog shell: renders a header (title), a body, and a pinned footer, and is
 * the single-scroll modal wrapper every manager dialog builds on.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '../../test/render';
import { Dialog } from './Dialog';

describe('Dialog', () => {
  it('renders the title, body and footer when opened', () => {
    render(
      <Dialog opened title="My title" footer={<button type="button">Apply</button>} onClose={() => {}}>
        <p>Body content</p>
      </Dialog>,
    );
    expect(screen.getByText('My title')).toBeInTheDocument();
    expect(screen.getByText('Body content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
  });

  it('renders nothing visible when closed', () => {
    render(
      <Dialog opened={false} title="Hidden" onClose={() => {}}>
        <p>Body content</p>
      </Dialog>,
    );
    expect(screen.queryByText('Body content')).not.toBeInTheDocument();
  });
});
