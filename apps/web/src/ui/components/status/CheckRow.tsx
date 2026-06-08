// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { useId, useState } from 'react';
import { redactSecrets } from '../../lib/formatting';

export type CheckStatus = 'pending' | 'running' | 'ok' | 'warning' | 'error';

export interface CheckRowProps {
  status: CheckStatus;
  title: string;
  description: string;
  /** Friendly one-line result, shown once the check has run. */
  detail?: string;
  /** Concrete suggested fix, shown only on failure. */
  fix?: string;
  /** Raw detail kept behind a "show technical details" disclosure. */
  technical?: string;
}

const ICON: Record<CheckStatus, string> = {
  pending: '○',
  running: '',
  ok: '✓',
  warning: '!',
  error: '×',
};

const LABEL: Record<CheckStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  ok: 'Passed',
  warning: 'Warning',
  error: 'Failed',
};

export function CheckRow({ status, title, description, detail, fix, technical }: CheckRowProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const detailId = useId();

  return (
    <div className="shm-check-row">
      <div className={`shm-check-row__icon shm-check-row__icon--${status}`} aria-hidden="true">
        {status === 'running' ? <span className="shm-spinner" /> : ICON[status]}
      </div>
      <div className="shm-check-row__body">
        <div className="shm-row shm-row--between">
          <span className="shm-check-row__title">{title}</span>
          <span className="shm-subtle" style={{ fontSize: '0.78rem', fontWeight: 600 }}>
            {LABEL[status]}
          </span>
        </div>
        <div className="shm-check-row__detail">{detail ? redactSecrets(detail) : description}</div>

        {status === 'error' && fix ? <div className="shm-check-row__fix">Suggested fix: {fix}</div> : null}

        {technical ? (
          <div className="shm-disclosure">
            <button
              type="button"
              className="shm-disclosure__btn"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? '▾' : '▸'} {open ? 'Hide technical details' : 'Show technical details'}
            </button>
            {open ? (
              <pre id={detailId} className="shm-command__code" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                {redactSecrets(technical)}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
