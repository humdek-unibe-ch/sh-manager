// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';

export interface WizardFrameProps {
  eyebrow?: string;
  title: string;
  lead?: string;
  children: ReactNode;
  /** Footer navigation (Back / Continue …). Omit on terminal screens. */
  footer?: ReactNode;
}

export function WizardFrame({ eyebrow, title, lead, children, footer }: WizardFrameProps): JSX.Element {
  return (
    <div className="shm-frame">
      <header className="shm-frame__head">
        {eyebrow ? <span className="shm-eyebrow">{eyebrow}</span> : null}
        <h1 className="shm-frame__title">{title}</h1>
        {lead ? <p className="shm-frame__lead">{lead}</p> : null}
      </header>
      <div className="shm-frame__body">{children}</div>
      {footer ? <div className="shm-frame__footer">{footer}</div> : null}
    </div>
  );
}
