// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';

export interface KeyValueRow {
  key: string;
  value: ReactNode;
  mono?: boolean;
}

export interface KeyValueProps {
  rows: KeyValueRow[];
}

/** A compact definition list for review/summary panels. */
export function KeyValue({ rows }: KeyValueProps): JSX.Element {
  return (
    <dl className="shm-kv">
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'contents' }}>
          <dt className="shm-kv__k">{row.key}</dt>
          <dd className={row.mono ? 'shm-kv__v shm-kv__v--mono' : 'shm-kv__v'} style={{ margin: 0 }}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
