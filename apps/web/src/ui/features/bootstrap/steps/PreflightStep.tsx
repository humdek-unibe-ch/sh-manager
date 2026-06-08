// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Alert, Button, CheckRow, WizardFrame, type CheckStatus } from '../../../components';
import { CHECK_META } from '../../../lib/wizard-view';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import type { CheckResult, WizardStepId } from '../../../lib/types';
import { StepFooter } from './shared';

const PREFLIGHT: WizardStepId[] = ['docker', 'internet', 'registry'];

function toStatus(result: CheckResult | undefined, running: boolean): CheckStatus {
  if (running) return 'running';
  if (!result) return 'pending';
  if (result.severity === 'error' || !result.ok) return 'error';
  if (result.severity === 'warning') return 'warning';
  return 'ok';
}

export interface PreflightStepProps {
  ctl: BootstrapController;
}

export function PreflightStep({ ctl }: PreflightStepProps): JSX.Element {
  const { state } = ctl;
  const snap = state.snapshot;
  if (!snap) return <span />;

  const current = snap.step;
  const currentResult = snap.checks[current];
  const currentPassed = Boolean(currentResult && currentResult.ok && currentResult.severity !== 'error');
  const meta = CHECK_META[current];

  const primary = currentPassed ? (
    <Button variant="primary" onClick={() => void ctl.continueStep()} loading={state.busy} disabled={!snap.canAdvance.ok}>
      Continue
    </Button>
  ) : (
    <Button
      variant="primary"
      onClick={() => void ctl.runCheck(current)}
      loading={state.runningCheck === current}
    >
      Run {meta?.title ?? current} check
    </Button>
  );

  return (
    <WizardFrame
      eyebrow="Preflight"
      title="Check this server is ready"
      lead="We verify Docker, connectivity and the official release registry before creating anything. Run each check — nothing is installed yet."
      footer={<StepFooter onBack={() => void ctl.goBack()} backDisabled={state.busy} primary={primary} />}
    >
      {state.actionError ? (
        <Alert tone="error" title="That check could not run">
          {state.actionError}
        </Alert>
      ) : null}

      <div className="shm-stack shm-stack--3">
        {PREFLIGHT.map((c) => {
          const m = CHECK_META[c];
          const result = snap.checks[c];
          const status = toStatus(result, state.runningCheck === c);
          return (
            <CheckRow
              key={c}
              status={status}
              title={m?.title ?? c}
              description={m?.description ?? ''}
              detail={result?.detail}
              fix={m?.fix}
            />
          );
        })}
      </div>
    </WizardFrame>
  );
}
