// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Alert, CommandPreview, KeyValue, StatusBadge, type BadgeTone, type KeyValueRow } from '../../../components';
import { instanceDir, publicUrlPreview } from '../../../lib/formatting';
import type { InstallResult, Snapshot, WizardConfig } from '../../../lib/types';

export interface SuccessStepProps {
  result: InstallResult | null;
  config: WizardConfig;
  snapshot: Snapshot;
}

function healthBadge(result: InstallResult | null, snapshot: Snapshot): { tone: BadgeTone; label: string } {
  const health = result?.health;
  if (health) {
    if (health.healthy && !health.degraded) return { tone: 'ok', label: 'All services healthy' };
    if (health.degraded) return { tone: 'warning', label: 'Running, some services degraded' };
    return { tone: 'error', label: 'Health checks did not pass' };
  }
  const check = snapshot.checks.health;
  if (!check) return { tone: 'neutral', label: 'Health unknown' };
  if (check.severity === 'warning') return { tone: 'warning', label: 'Running, some services degraded' };
  if (check.severity === 'error' || !check.ok) return { tone: 'error', label: 'Health checks did not pass' };
  return { tone: 'ok', label: 'All services healthy' };
}

export function SuccessStep({ result, config, snapshot }: SuccessStepProps): JSX.Element {
  const url = result?.publicUrl ?? publicUrlPreview(config);
  const dir = result?.outcome.instanceDir ?? instanceDir(config.root, config.instanceId);
  const version = result?.outcome.version ?? config.version;
  const health = healthBadge(result, snapshot);

  const paths: KeyValueRow[] = [
    { key: 'Instance directory', value: dir, mono: true },
    { key: 'Manifest', value: `${dir}/manifest.json`, mono: true },
    { key: 'Lock file', value: `${dir}/lock.json`, mono: true },
    { key: 'Operator README', value: `${dir}/README.md`, mono: true },
    { key: 'Backups', value: `${dir}/backups`, mono: true },
  ];

  return (
    <div className="shm-frame">
      <div className="shm-hero">
        <div className="shm-hero__badge" aria-hidden="true">
          ✓
        </div>
        <h1 className="shm-frame__title">{config.instanceName || 'Your instance'} is ready</h1>
        <p className="shm-frame__lead" style={{ textAlign: 'center' }}>
          SelfHelp {version} is installed and the services have been started.
        </p>
        <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
      </div>

      <div className="shm-card shm-card--pad shm-stack shm-stack--3">
        <span className="shm-eyebrow">Open your instance</span>
        <CommandPreview value={url} label="public URL" />
        <div className="shm-row shm-row--wrap" style={{ gap: 'var(--shm-space-3)' }}>
          <a className="shm-btn shm-btn--primary shm-btn--lg" href={url} target="_blank" rel="noreferrer noopener">
            Open SelfHelp ↗
          </a>
        </div>
      </div>

      <Alert tone="warning" title="Save your admin password now">
        The generated administrator password is stored in a restricted file inside the instance directory and shown by
        the installer process once. Retrieve it from the server now and store it in your password manager — it is not
        displayed in this UI.
      </Alert>

      <div className="shm-grid shm-grid--2">
        <div className="shm-card shm-card--pad shm-stack shm-stack--3">
          <span className="shm-eyebrow">Important paths</span>
          <KeyValue rows={paths} />
        </div>
        <div className="shm-card shm-card--pad shm-stack shm-stack--3">
          <span className="shm-eyebrow">Operator commands</span>
          <CommandPreview value={`sh-manager instance health ${config.instanceId}`} label="health command" />
          <CommandPreview value={`sh-manager backup create ${config.instanceId}`} label="backup command" />
          <p className="shm-subtle" style={{ fontSize: '0.82rem' }}>
            Run these on the server. Full instructions are in the operator README above.
          </p>
        </div>
      </div>
    </div>
  );
}
