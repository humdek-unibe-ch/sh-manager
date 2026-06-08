// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Alert, Button, CommandPreview, TextField, WizardFrame } from '../../../components';
import { STEP_COPY } from '../../../lib/wizard-view';
import { publicUrlPreview } from '../../../lib/formatting';
import { validateStep } from '../../../../wizard';
import type { BootstrapController } from '../../../hooks/useBootstrap';
import { pickProblem, StepFooter } from './shared';

export interface DomainStepProps {
  ctl: BootstrapController;
}

export function DomainStep({ ctl }: DomainStepProps): JSX.Element {
  const cfg = ctl.effectiveConfig;
  if (!cfg) return <span />;
  const copy = STEP_COPY.domain;
  const problems = validateStep('domain', cfg);
  const isProd = cfg.mode === 'production';
  const previewUrl = publicUrlPreview(cfg);

  return (
    <WizardFrame
      eyebrow={copy?.eyebrow ?? 'Public address'}
      title={isProd ? 'Public domain' : 'Localhost port'}
      lead={copy?.lead}
      footer={
        <StepFooter
          onBack={() => void ctl.goBack()}
          backDisabled={ctl.state.busy}
          primary={
            <Button
              variant="primary"
              onClick={() => void ctl.continueStep()}
              loading={ctl.state.busy}
              disabled={problems.length > 0}
            >
              Continue
            </Button>
          }
        />
      }
    >
      <div className="shm-card shm-card--pad shm-stack shm-stack--4">
        {isProd ? (
          <>
            <TextField
              label="Public domain"
              value={cfg.domain ?? ''}
              onChange={(v) => ctl.patchDraft({ domain: v })}
              help="The fully-qualified domain that resolves to this server, e.g. app.university.edu."
              placeholder="app.university.edu"
              error={pickProblem(problems, 'domain')}
              required
            />
            <TextField
              label="Let's Encrypt email"
              type="email"
              value={cfg.letsencryptEmail ?? ''}
              onChange={(v) => ctl.patchDraft({ letsencryptEmail: v })}
              help="Used by the proxy for TLS certificate notices. Optional but recommended."
              placeholder="ops@university.edu"
              error={pickProblem(problems, "let's encrypt", 'email')}
            />
          </>
        ) : (
          <TextField
            label="Localhost port"
            type="number"
            inputMode="numeric"
            value={cfg.localPort !== undefined ? String(cfg.localPort) : ''}
            onChange={(v) => ctl.patchDraft({ localPort: v === '' ? undefined : Number(v) })}
            help="A free TCP port on this machine, e.g. 8080."
            placeholder="8080"
            error={pickProblem(problems, 'port')}
            required
          />
        )}
      </div>

      <div className="shm-card shm-card--pad shm-stack shm-stack--3">
        <span className="shm-eyebrow">Public URL preview</span>
        <CommandPreview value={previewUrl} label="public URL" />
        {isProd ? (
          <Alert tone="warning" title="DNS is validated before install">
            We check that <strong>{cfg.domain || 'your domain'}</strong> resolves. If it does not point to this server
            yet, update your DNS first — TLS will fail otherwise.
          </Alert>
        ) : null}
      </div>
    </WizardFrame>
  );
}
