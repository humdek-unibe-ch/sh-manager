// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Alert, Button, WizardFrame } from '../../../components';
import { STEP_COPY } from '../../../lib/wizard-view';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import { StepFooter } from './shared';

export interface ProxyStepProps {
  ctl: BootstrapController;
}

export function ProxyStep({ ctl }: ProxyStepProps): JSX.Element {
  const cfg = ctl.effectiveConfig;
  if (!cfg) return <span />;
  const copy = STEP_COPY.proxy;
  const isProd = cfg.mode === 'production';

  return (
    <WizardFrame
      eyebrow={copy?.eyebrow ?? 'Networking'}
      title={copy?.title ?? 'Shared reverse proxy'}
      lead={copy?.lead}
      footer={
        <StepFooter
          onBack={() => void ctl.goBack()}
          backDisabled={ctl.state.busy}
          primary={
            <Button variant="primary" onClick={() => void ctl.continueStep()} loading={ctl.state.busy}>
              Continue
            </Button>
          }
        />
      }
    >
      <div className="shm-card shm-card--pad shm-stack shm-stack--3">
        <div className="shm-row" style={{ gap: 'var(--shm-space-3)' }}>
          <span className="shm-choice__icon" aria-hidden="true">
            🔀
          </span>
          <div>
            <div className="shm-card__title">Traefik router</div>
            <div className="shm-muted" style={{ fontSize: '0.9rem' }}>
              One proxy handles routing for every instance on this server.
            </div>
          </div>
        </div>
        <ul className="shm-stack shm-stack--2 shm-muted" style={{ margin: 0, paddingLeft: '1.1em', fontSize: '0.9rem' }}>
          <li>Routes each instance by its domain or port</li>
          {isProd ? <li>Obtains and renews TLS certificates automatically</li> : <li>Exposes the instance on its localhost port</li>}
          <li>Created once and reused by future instances</li>
        </ul>
      </div>
      <Alert tone="info" title="Nothing to configure here">
        The proxy is set up automatically with safe defaults. Continue when you are ready.
      </Alert>
    </WizardFrame>
  );
}
