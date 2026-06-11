// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Center, Stack, Text } from '@mantine/core';
import { Alert, Button, Spinner, WizardStepper } from '../../components';
import { useBootstrap } from '../../hooks/useBootstrap';
import type { ApiClient } from '../../lib/api-client';
import { WIZARD_PHASES, activePhaseIndex } from '../../lib/wizard-view';
import { AdminStep } from './steps/AdminStep';
import { DomainStep } from './steps/DomainStep';
import { InstallProgressStep } from './steps/InstallProgressStep';
import { InstanceStep } from './steps/InstanceStep';
import { LocationStep } from './steps/LocationStep';
import { ModeStep } from './steps/ModeStep';
import { PreflightStep } from './steps/PreflightStep';
import { ProxyStep } from './steps/ProxyStep';
import { ResourcesStep } from './steps/ResourcesStep';
import { ReviewStep } from './steps/ReviewStep';
import { SuccessStep } from './steps/SuccessStep';
import { WelcomeStep } from './steps/WelcomeStep';

export interface BootstrapWizardProps {
  /** Injected for tests; defaults to the real BFF client. */
  client?: ApiClient;
}

export function BootstrapWizard({ client }: BootstrapWizardProps): JSX.Element {
  const ctl = useBootstrap(client);
  const { state, effectiveConfig } = ctl;

  if (state.status === 'loading') {
    return (
      <Center mih="50vh">
        <Stack align="center" gap="sm">
          <Spinner size="lg" />
          <Text c="dimmed">Connecting to the installer…</Text>
        </Stack>
      </Center>
    );
  }

  if (state.status === 'error' || !state.snapshot || !effectiveConfig) {
    return (
      <Center mih="50vh">
        <Stack maw={460} w="100%" gap="md">
          <Alert tone="error" title="Cannot reach the installer service">
            {state.loadError ?? 'The manager service is not responding.'}
          </Alert>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </Stack>
      </Center>
    );
  }

  const snapshot = state.snapshot;
  const installed = Boolean(state.installResult);
  const phaseIndex = activePhaseIndex(snapshot.step, state.installing, installed);

  return (
    <Stack gap="xl">
      <WizardStepper phases={WIZARD_PHASES} activeIndex={phaseIndex} />
      {renderStep()}
    </Stack>
  );

  function renderStep(): JSX.Element {
    if (installed) {
      return <SuccessStep result={state.installResult} config={effectiveConfig!} snapshot={snapshot} />;
    }
    switch (snapshot.step) {
      case 'welcome':
        return <WelcomeStep ctl={ctl} />;
      case 'docker':
      case 'internet':
      case 'registry':
        return <PreflightStep ctl={ctl} />;
      case 'install_root':
        return <LocationStep ctl={ctl} />;
      case 'resources':
        return <ResourcesStep ctl={ctl} />;
      case 'mode':
        return <ModeStep ctl={ctl} />;
      case 'domain':
        return <DomainStep ctl={ctl} />;
      case 'proxy':
        return <ProxyStep ctl={ctl} />;
      case 'instance':
        return <InstanceStep ctl={ctl} />;
      case 'admin':
        return <AdminStep ctl={ctl} />;
      case 'install':
        if (state.installing) return <InstallProgressStep phase="running" />;
        if (state.installError) {
          return (
            <InstallProgressStep
              phase="failed"
              error={state.installError}
              failedStep={state.installFailure?.failedStep}
              onRetry={() => void ctl.install()}
              onBack={() => void ctl.goBack()}
            />
          );
        }
        return <ReviewStep ctl={ctl} />;
      case 'health':
        return <InstallProgressStep phase="running" />;
      case 'done':
        return <SuccessStep result={state.installResult} config={effectiveConfig!} snapshot={snapshot} />;
      default:
        return <span />;
    }
  }
}
