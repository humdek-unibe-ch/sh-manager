// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
export type MetricStatus = 'ok' | 'warning' | 'blocked' | 'neutral';

export interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  status?: MetricStatus;
}

export function MetricCard({ label, value, hint, status = 'neutral' }: MetricCardProps): JSX.Element {
  const cls = status === 'neutral' ? 'shm-metric' : `shm-metric shm-metric--${status}`;
  return (
    <div className={cls}>
      <div className="shm-metric__label">{label}</div>
      <div className="shm-metric__value">{value}</div>
      {hint ? <div className="shm-metric__hint">{hint}</div> : null}
    </div>
  );
}
