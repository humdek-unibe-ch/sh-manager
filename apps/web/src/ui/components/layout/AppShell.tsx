// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Brand } from './Brand';

export interface AppShellProps {
  subtitle?: string;
  /** Rendered on the right of the header (status badge, sign-out, …). */
  headerActions?: ReactNode;
  children: ReactNode;
}

export function AppShell({ subtitle, headerActions, children }: AppShellProps): JSX.Element {
  return (
    <div className="shm-shell">
      <header className="shm-shell__header">
        <Brand subtitle={subtitle} />
        {headerActions ? <div className="shm-shell__actions">{headerActions}</div> : null}
      </header>
      <main className="shm-shell__main">{children}</main>
      <footer className="shm-shell__footer">
        SelfHelp Manager · Docker-only connected installer · runs locally, never exposes secrets
      </footer>
    </div>
  );
}
