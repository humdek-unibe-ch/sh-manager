// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Step views for the create-instance wizard. Each reads the shared form object
 * (see {@link useCreateInstanceForm}) and renders exactly the markup the wizard
 * used to inline, so the DOM + behaviour are unchanged. `InstallProgress` is the
 * post-submit live-log view shown once the install operation starts.
 */
import { Code, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import {
  Alert,
  Button,
  Checkbox,
  CheckRow,
  ChoiceCard,
  KeyValue,
  StatusBadge,
  StepProgress,
  TextField,
  type CheckStatus,
  type ProgressStep,
} from '../../components';
import { ApiError } from '../../lib/api-client';
import { CHECK_META, CREATE_INSTANCE_STEPS, createStepIndexForPhase } from '../../lib/wizard-view';
import type { CheckResult } from '../../lib/types';
import { OperationLog, operationTone } from './OperationLog';
import { VersionSelect } from './VersionSelect';
import { PREFLIGHT_ORDER, type CreateInstanceForm } from './use-create-instance-form';

function preflightStatus(result: CheckResult | undefined, running: boolean): CheckStatus {
  if (running) return 'running';
  if (!result) return 'pending';
  if (!result.ok || result.severity === 'error') return 'error';
  if (result.severity === 'warning') return 'warning';
  return 'ok';
}

export function WelcomeStep({ form }: { form: CreateInstanceForm }): JSX.Element {
  const { isFirstInstall } = form;
  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="lg">
        <Stack gap="sm">
          <Title order={4}>{isFirstInstall ? 'Set up this server with its first instance' : 'Add another instance to this server'}</Title>
          <Text size="sm">
            The wizard checks the environment, asks for a few details, and then installs a verified SelfHelp
            release: containers, database, first admin account and health checks — fully automatic.
          </Text>
          {isFirstInstall ? (
            <Text size="sm" c="dimmed">
              Because this is the first instance, the manager also prepares the server itself: the shared
              reverse proxy (which routes every instance and manages TLS certificates) and the server
              inventory.
            </Text>
          ) : (
            <Text size="sm" c="dimmed">
              The server is already set up — the new instance is fully isolated (own containers, database,
              secrets and backups) and joins the shared reverse proxy.
            </Text>
          )}
        </Stack>
      </Paper>
      <Alert tone="info" title="Safe to cancel">
        Nothing is created until you confirm on the Review step.
      </Alert>
    </Stack>
  );
}

export function PreflightStep({ form }: { form: CreateInstanceForm }): JSX.Element {
  const { preflightData, preflight } = form;
  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="lg">
        <Stack gap="md">
          {PREFLIGHT_ORDER.map((key) => {
            const meta = CHECK_META[key];
            const result = preflightData?.[key];
            return (
              <CheckRow
                key={key}
                status={preflightStatus(result, preflight.isPending)}
                title={meta?.title ?? key}
                description={meta?.description ?? ''}
                detail={result?.detail}
                fix={meta?.fix}
              />
            );
          })}
        </Stack>
      </Paper>
      {preflight.isError ? (
        <Alert tone="error" title="Preflight could not run">
          {preflight.error instanceof ApiError ? preflight.error.message : 'The manager service did not answer.'}
        </Alert>
      ) : null}
      <Group>
        <Button variant="secondary" loading={preflight.isPending} onClick={() => preflight.mutate()}>
          Run checks again
        </Button>
      </Group>
    </Stack>
  );
}

export function BasicsStep({ form }: { form: CreateInstanceForm }): JSX.Element {
  const {
    displayName,
    onName,
    instanceId,
    setInstanceId,
    idError,
    adminEmail,
    setAdminEmail,
    emailError,
    adminName,
    setAdminName,
    mailerDsn,
    setMailerDsn,
    mailerError,
  } = form;
  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="lg">
        <Stack gap="md">
          <Group grow align="flex-start">
            <TextField
              label="Display name"
              value={displayName}
              onChange={onName}
              required
              placeholder="Clinic A"
              help="A human-friendly name shown in the manager."
            />
            <TextField
              label="Instance id"
              value={instanceId}
              onChange={(v) => setInstanceId(v.toLowerCase())}
              required
              placeholder="clinic-a"
              help="Lowercase letters, digits and hyphens. Used for folders, containers and routing."
              {...(idError ? { error: idError } : {})}
            />
          </Group>
          <Group grow align="flex-start">
            <TextField
              label="Admin email"
              value={adminEmail}
              onChange={setAdminEmail}
              required
              type="email"
              placeholder="admin@example.org"
              help="Sign-in email for the first admin account."
              {...(emailError ? { error: emailError } : {})}
            />
            <TextField label="Admin name" value={adminName} onChange={setAdminName} placeholder="Optional" help="Optional display name for the admin account." />
          </Group>
          <TextField
            label="Outbound email (SMTP DSN)"
            value={mailerDsn}
            onChange={setMailerDsn}
            placeholder="smtp://user:pass@mail.example.org:587"
            help="Optional. How this instance sends email (password resets, notifications). Leave empty to use the bundled Mailpit test mailbox — you can change it any time from the instance page."
            {...(mailerError ? { error: mailerError } : {})}
          />
        </Stack>
      </Paper>
      <Alert tone="info" title="About the admin password">
        The generated admin password is never shown in the browser: it is written to a restricted (0600)
        file on the server and the install log shows the file path — read it over SSH after the install
        finishes.
      </Alert>
    </Stack>
  );
}

export function AddressStep({ form }: { form: CreateInstanceForm }): JSX.Element {
  const {
    mode,
    setMode,
    domain,
    setDomain,
    domainError,
    isFirstInstall,
    letsencryptEmail,
    setLetsencryptEmail,
    adminEmail,
    letsencryptError,
    localPort,
    setLocalPort,
    portError,
    publicAddress,
  } = form;
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <ChoiceCard
          title="Production"
          description="Reachable on a public domain with automatic TLS via the shared proxy."
          bullets={['Needs a DNS record pointing at this server', 'Let’s Encrypt certificate is issued automatically']}
          selected={mode === 'production'}
          recommended
          onSelect={() => setMode('production')}
        />
        <ChoiceCard
          title="Local"
          description="Bound to a localhost port on this server — for testing and staging."
          bullets={['No DNS or TLS required', 'Reach it through an SSH tunnel']}
          selected={mode === 'local'}
          onSelect={() => setMode('local')}
        />
      </SimpleGrid>
      <Paper withBorder radius="md" p="lg">
        <Stack gap="md">
          {mode === 'production' ? (
            <>
              <TextField
                label="Domain"
                value={domain}
                onChange={setDomain}
                required
                placeholder="site.example.org"
                help="Create the DNS A/AAAA record for this hostname before installing — you can change it later from the instance page."
                {...(domainError ? { error: domainError } : {})}
              />
              {isFirstInstall ? (
                <TextField
                  label="Let's Encrypt contact email"
                  value={letsencryptEmail}
                  onChange={setLetsencryptEmail}
                  type="email"
                  placeholder={adminEmail || 'ops@example.org'}
                  help="Optional. Receives certificate-expiry notices from Let's Encrypt. Used once, when the shared proxy is created with this first install."
                  {...(letsencryptError ? { error: letsencryptError } : {})}
                />
              ) : null}
            </>
          ) : (
            <TextField
              label="Local port"
              value={localPort}
              onChange={setLocalPort}
              required
              inputMode="numeric"
              help="Published on 127.0.0.1 only — you can change it later from the instance page."
              {...(portError ? { error: portError } : {})}
            />
          )}
          <Text size="sm" c="dimmed">
            The instance will be reachable at <Code>{publicAddress}</Code>.
          </Text>
        </Stack>
      </Paper>
    </Stack>
  );
}

export function ReleaseStep({ form }: { form: CreateInstanceForm }): JSX.Element {
  const { client, useTestChannel, setUseTestChannel, version, setVersion, preflightData } = form;
  return (
    <Paper withBorder radius="md" p="lg">
      <Stack gap="md">
        <VersionSelect
          client={client}
          {...(useTestChannel ? { channel: 'test' } : {})}
          value={version}
          onChange={setVersion}
        />
        <Checkbox checked={useTestChannel} onChange={setUseTestChannel}>
          Use the test channel (pre-release builds)
        </Checkbox>
        <TextField
          label="Registry URL"
          value={preflightData?.registryUrl ?? 'official signed SelfHelp registry'}
          onChange={() => undefined}
          disabled
          help="Fixed to the official signed SelfHelp registry."
        />
      </Stack>
    </Paper>
  );
}

export function ReviewStep({ form }: { form: CreateInstanceForm }): JSX.Element {
  const { displayName, instanceId, mode, publicAddress, version, useTestChannel, adminName, adminEmail, mailerDsn, isFirstInstall, start } =
    form;
  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="lg">
        <KeyValue
          rows={[
            { key: 'Instance', value: `${displayName.trim()} (${instanceId})` },
            { key: 'Mode', value: mode === 'production' ? 'Production (domain + TLS)' : 'Local (localhost port)' },
            { key: 'Address', value: publicAddress, mono: true },
            { key: 'Version', value: version === '' ? 'latest' : version },
            { key: 'Channel', value: useTestChannel ? 'test (pre-release)' : 'stable' },
            { key: 'Admin', value: adminName.trim() !== '' ? `${adminName.trim()} <${adminEmail}>` : adminEmail },
            {
              key: 'Outbound email',
              value: mailerDsn.trim() !== '' ? 'Custom SMTP (credentials hidden)' : 'Bundled Mailpit test mailbox',
            },
            ...(isFirstInstall
              ? [{ key: 'Server setup', value: 'First instance — also creates the shared proxy & inventory' }]
              : []),
          ]}
        />
      </Paper>
      <Alert tone="info" title="What happens next">
        The manager downloads the verified release, starts the containers, provisions the database and
        creates the first admin account. The admin password is never shown in the browser — read it over
        SSH from the restricted file shown in the install log.
      </Alert>
      {start.isError ? (
        <Alert tone="error" title="Could not start the install">
          {start.error instanceof ApiError ? start.error.message : 'The manager service did not answer.'}
        </Alert>
      ) : null}
    </Stack>
  );
}

export function InstallProgress({
  form,
  onClose,
  onOpenInstance,
}: {
  form: CreateInstanceForm;
  onClose: () => void;
  onOpenInstance?: (instanceId: string) => void;
}): JSX.Element {
  const { client, opStatus, operationQuery, operationId, displayName, instanceId, publicAddress, setOperationId } = form;
  // Real progress: the journaled operation phase marks the active row —
  // earlier rows are done, later rows are waiting.
  const activeIndex = opStatus === 'succeeded' ? CREATE_INSTANCE_STEPS.length : createStepIndexForPhase(operationQuery.data?.phase);
  const progressSteps: ProgressStep[] = CREATE_INSTANCE_STEPS.map((s, i) => {
    const state: ProgressStep['state'] =
      i < activeIndex
        ? 'success'
        : i === activeIndex
          ? opStatus === 'failed'
            ? 'failed'
            : 'running'
          : 'waiting';
    return { id: s.id, label: s.label, state, ...(s.note ? { note: s.note } : {}) };
  });

  return (
    <Stack gap="md">
      <Group gap="sm">
        {opStatus ? <StatusBadge tone={operationTone(opStatus)}>{opStatus}</StatusBadge> : null}
        <Text size="sm" c="dimmed">
          The install continues on the server even if you leave this page — the live log stays available
          on the dashboard.
        </Text>
      </Group>

      <Paper withBorder radius="md" p="lg">
        <StepProgress steps={progressSteps} />
      </Paper>

      {opStatus === 'failed' && operationQuery.data?.error ? (
        <Alert tone="error" title="What failed">
          {operationQuery.data.error}
        </Alert>
      ) : null}

      <OperationLog client={client} operationId={operationId!} showSteps={false} />

      {opStatus === 'succeeded' ? (
        <Alert tone="success" title={`"${displayName.trim() || instanceId}" is installed`}>
          The instance is reachable at <Code>{publicAddress}</Code>. The generated admin password is in the
          restricted file shown in the result above — read it over SSH.
        </Alert>
      ) : null}

      <Group justify="flex-end" gap="sm" mt="sm">
        {opStatus === 'failed' ? (
          <Button variant="secondary" onClick={() => setOperationId(null)}>
            Back to the form
          </Button>
        ) : null}
        {opStatus === 'succeeded' && onOpenInstance ? (
          <Button variant="primary" onClick={() => onOpenInstance(instanceId)}>
            Open instance
          </Button>
        ) : null}
        <Button variant={opStatus === 'succeeded' ? 'secondary' : 'ghost'} onClick={onClose}>
          Close
        </Button>
      </Group>
    </Stack>
  );
}
