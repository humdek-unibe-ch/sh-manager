// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Authenticated operations console (persistent mode).
 *
 * The current BFF exposes live environment checks + auth, but not yet a
 * read API for the server inventory. So this console surfaces real, live
 * server status (Docker, connectivity, registry, resources) and the exact
 * operator CLI commands for instance lifecycle actions — it never invents
 * instance data it cannot fetch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CheckRow,
  CommandPreview,
  EmptyState,
  Spinner,
  StatusBadge,
  type BadgeTone,
  type CheckStatus,
} from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { CHECK_META } from '../../lib/wizard-view';
import type { CheckResult, Snapshot, WizardStepId } from '../../lib/types';

const CHECKS: WizardStepId[] = ['docker', 'internet', 'registry', 'resources'];

const OPERATOR_COMMANDS: { label: string; command: string }[] = [
  { label: 'Check instance health', command: 'sh-manager instance health <instance-id>' },
  { label: 'Create a backup', command: 'sh-manager backup create <instance-id>' },
  { label: 'Preview an update (dry run)', command: 'sh-manager instance update <instance-id> --dry-run' },
  { label: 'Apply an update', command: 'sh-manager instance update <instance-id>' },
  { label: 'Generate a support bundle', command: 'sh-manager support bundle <instance-id>' },
  { label: 'Safe-mode guidance', command: 'sh-manager doctor' },
];

function checkStatus(result: CheckResult | undefined, running: boolean): CheckStatus {
  if (running) return 'running';
  if (!result) return 'pending';
  if (result.severity === 'error' || !result.ok) return 'error';
  if (result.severity === 'warning') return 'warning';
  return 'ok';
}

export interface OperationsConsoleProps {
  client: ApiClient;
}

export function OperationsConsole({ client }: OperationsConsoleProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [running, setRunning] = useState<WizardStepId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const snap = await client.getState();
        if (active) setSnapshot(snap);
      } catch (err) {
        if (active) setError(err instanceof ApiError ? err.message : 'Could not load server status.');
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const run = useCallback(
    async (step: WizardStepId) => {
      setRunning(step);
      setError(null);
      try {
        setSnapshot(await client.runCheck(step));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'That check could not run.');
      } finally {
        setRunning(null);
      }
    },
    [client],
  );

  const overall = useMemo<{ tone: BadgeTone; label: string }>(() => {
    if (!snapshot) return { tone: 'pending', label: 'Unknown' };
    const results = CHECKS.map((c) => snapshot.checks[c]).filter(Boolean) as CheckResult[];
    if (results.length === 0) return { tone: 'pending', label: 'Not checked yet' };
    if (results.some((r) => r.severity === 'error' || !r.ok)) return { tone: 'error', label: 'Needs attention' };
    if (results.some((r) => r.severity === 'warning')) return { tone: 'warning', label: 'Degraded' };
    return { tone: 'ok', label: 'Healthy' };
  }, [snapshot]);

  if (!loaded) {
    return (
      <div className="shm-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="shm-stack shm-stack--5">
      <div className="shm-row shm-row--between shm-row--wrap">
        <div>
          <h1 className="shm-frame__title" style={{ fontSize: '1.4rem' }}>
            Server operations
          </h1>
          <p className="shm-muted">Live status of this SelfHelp server and the operator actions available to you.</p>
        </div>
        <div className="shm-row" style={{ gap: 'var(--shm-space-3)' }}>
          <StatusBadge tone={overall.tone}>{overall.label}</StatusBadge>
          <Button
            variant="secondary"
            onClick={() => {
              void (async () => {
                for (const c of CHECKS) await run(c);
              })();
            }}
            loading={running !== null}
          >
            Run all checks
          </Button>
        </div>
      </div>

      {error ? (
        <Alert tone="error" title="Something went wrong">
          {error}
        </Alert>
      ) : null}

      <Card title="Environment status" description="Re-run any check to refresh its status.">
        <div className="shm-stack shm-stack--3">
          {CHECKS.map((c) => {
            const meta = CHECK_META[c];
            const result = snapshot?.checks[c];
            const status = checkStatus(result, running === c);
            return (
              <div key={c} className="shm-row" style={{ gap: 'var(--shm-space-3)', alignItems: 'stretch' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <CheckRow
                    status={status}
                    title={meta?.title ?? c}
                    description={meta?.description ?? ''}
                    detail={result?.detail}
                    fix={meta?.fix}
                  />
                </div>
                <Button variant="ghost" onClick={() => void run(c)} loading={running === c} aria-label={`Run ${meta?.title ?? c} check`}>
                  Run
                </Button>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Instances" aside={<StatusBadge tone="neutral">CLI-managed</StatusBadge>}>
        <EmptyState icon="📦" title="Instance management runs on the server">
          Listing and updating instances from the web is on the roadmap. For now, use these operator commands on the
          server (replace <code>&lt;instance-id&gt;</code>).
        </EmptyState>
        <div className="shm-grid shm-grid--2" style={{ marginTop: 'var(--shm-space-4)' }}>
          {OPERATOR_COMMANDS.map((c) => (
            <div key={c.label} className="shm-stack shm-stack--2">
              <span className="shm-field__label">{c.label}</span>
              <CommandPreview value={c.command} label={c.label} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
