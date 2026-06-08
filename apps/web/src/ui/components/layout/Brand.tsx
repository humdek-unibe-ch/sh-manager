// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
export interface BrandProps {
  subtitle?: string;
}

export function Brand({ subtitle }: BrandProps): JSX.Element {
  return (
    <div className="shm-brand">
      <div className="shm-brand__mark" aria-hidden="true">
        SH
      </div>
      <div>
        <div className="shm-brand__name">SelfHelp Manager</div>
        {subtitle ? <div className="shm-brand__sub">{subtitle}</div> : null}
      </div>
    </div>
  );
}
