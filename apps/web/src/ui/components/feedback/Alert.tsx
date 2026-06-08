// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

export interface AlertProps {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
}

const ICON: Record<AlertTone, string> = {
  info: 'i',
  success: '✓',
  warning: '!',
  error: '×',
};

export function Alert({ tone = 'info', title, children }: AlertProps): JSX.Element {
  return (
    <div className={`shm-alert shm-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="shm-alert__icon" aria-hidden="true">
        {ICON[tone]}
      </div>
      <div>
        {title ? <div className="shm-alert__title">{title}</div> : null}
        {children ? <div className="shm-alert__body">{children}</div> : null}
      </div>
    </div>
  );
}
