// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';

export interface CardProps {
  title?: string;
  description?: string;
  /** Rendered top-right of the header (badge, action…). */
  aside?: ReactNode;
  raised?: boolean;
  children?: ReactNode;
}

export function Card({ title, description, aside, raised, children }: CardProps): JSX.Element {
  return (
    <section className={`shm-card shm-card--pad${raised ? ' shm-card--raised' : ''}`}>
      {title || aside ? (
        <div className="shm-row shm-row--between" style={{ marginBottom: description ? 4 : 'var(--shm-space-3)' }}>
          {title ? <h3 className="shm-card__title">{title}</h3> : <span />}
          {aside ?? null}
        </div>
      ) : null}
      {description ? <p className="shm-card__desc" style={{ marginBottom: 'var(--shm-space-3)' }}>{description}</p> : null}
      {children}
    </section>
  );
}
