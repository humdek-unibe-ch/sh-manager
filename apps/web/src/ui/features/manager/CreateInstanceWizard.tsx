// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Create-instance wizard: the guided, full-page experience for every install
 * (the only install flow — on a fresh server the FIRST run of this wizard
 * also bootstraps the server: shared proxy + inventory, journalled as the
 * `server init` phase).
 *
 * Welcome → Preflight → Basics → Address → Release → Review, then the
 * journaled install log with a live step checklist. Validation mirrors the
 * server exactly: the step gates reuse the shared `instance-validation`
 * module the BFF route runs, so the wizard can never submit a request the
 * server would reject. The version is picked from the verified release
 * registry and the generated admin password never reaches the browser —
 * provisioning writes it to a root-readable file on the server.
 *
 * The form state + validation live in {@link useCreateInstanceForm}; the step
 * views live in `create-instance-steps`. This component is the orchestrator:
 * the header, the stepper, the per-step footer and the form/log switch.
 */
import { Divider, Group, Stack, Text, Title } from '@mantine/core';
import { Button, WizardStepper } from '../../components';
import type { ApiClient } from '../../lib/api-client';
import { useCreateInstanceForm, type PhaseIndex } from './use-create-instance-form';
import {
  AddressStep,
  BasicsStep,
  InstallProgress,
  PreflightStep,
  ReleaseStep,
  ReviewStep,
  WelcomeStep,
} from './create-instance-steps';

const PHASES = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'preflight', label: 'Preflight' },
  { id: 'basics', label: 'Basics' },
  { id: 'address', label: 'Address' },
  { id: 'release', label: 'Release' },
  { id: 'review', label: 'Review' },
] as const;

export interface CreateInstanceWizardProps {
  client: ApiClient;
  /** Leave the wizard (back to the dashboard). */
  onClose: () => void;
  /** Called with the started operation id as soon as the install begins. */
  onStarted: (operationId: string) => void;
  /** Called when the operator opens the freshly installed instance. */
  onOpenInstance?: (instanceId: string) => void;
}

export function CreateInstanceWizard({
  client,
  onClose,
  onStarted,
  onOpenInstance,
}: CreateInstanceWizardProps): JSX.Element {
  const form = useCreateInstanceForm(client, onStarted);
  const { step, setStep, stepReady, start, request, operationId, isFirstInstall, instanceId } = form;

  function footer(): JSX.Element {
    return (
      <Group justify="space-between" mt="sm">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Group gap="sm">
          {step > 0 ? (
            <Button variant="secondary" onClick={() => setStep((step - 1) as PhaseIndex)}>
              Back
            </Button>
          ) : null}
          {step < 5 ? (
            <Button variant="primary" disabled={!stepReady[step]} onClick={() => setStep((step + 1) as PhaseIndex)}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" loading={start.isPending} onClick={() => start.mutate(request)}>
              Install instance
            </Button>
          )}
        </Group>
      </Group>
    );
  }

  function renderStep(): JSX.Element {
    switch (step) {
      case 0:
        return <WelcomeStep form={form} />;
      case 1:
        return <PreflightStep form={form} />;
      case 2:
        return <BasicsStep form={form} />;
      case 3:
        return <AddressStep form={form} />;
      case 4:
        return <ReleaseStep form={form} />;
      default:
        return <ReviewStep form={form} />;
    }
  }

  return (
    <Stack gap="lg" maw={960} mx="auto">
      <Stack gap={4}>
        <Title order={3}>
        {operationId
          ? `Installing ${instanceId}`
          : isFirstInstall
            ? 'Set up SelfHelp on this server'
            : 'Create a new instance'}
        </Title>
        <Text size="sm" c="dimmed">
          {operationId
            ? 'Live install log — straight from the operation journal on the server.'
            : 'The manager installs a verified release, provisions the database and creates the first admin account.'}
        </Text>
      </Stack>
      {operationId === null ? <WizardStepper phases={[...PHASES]} activeIndex={step} /> : null}
      {operationId === null ? (
        <>
          {renderStep()}
          <Divider />
          {footer()}
        </>
      ) : (
        <InstallProgress form={form} onClose={onClose} {...(onOpenInstance ? { onOpenInstance } : {})} />
      )}
    </Stack>
  );
}
