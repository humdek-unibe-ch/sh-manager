// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: string;
  title: string;
  children?: ReactNode;
}

export function EmptyState({ icon = '◦', title, children }: EmptyStateProps): JSX.Element {
  return (
    <div className="shm-empty">
      <div className="shm-empty__icon" aria-hidden="true">
        {icon}
      </div>
      <div className="shm-empty__title">{title}</div>
      {children ? <div className="shm-muted">{children}</div> : null}
    </div>
  );
}
