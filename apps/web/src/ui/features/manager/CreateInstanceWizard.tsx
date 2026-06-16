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
 */
import { useEffect, useState } from 'react';
import { Code, Divider, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
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
  WizardStepper,
  type CheckStatus,
  type ProgressStep,
} from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { slugify } from '../../lib/formatting';
import { CHECK_META, CREATE_INSTANCE_STEPS, createStepIndexForPhase } from '../../lib/wizard-view';
import type { CheckResult, CreateInstanceRequest, PreflightResult } from '../../lib/types';
import {
  EMAIL_RE,
  HOSTNAME_RE,
  INSTANCE_ID_RE,
  MAILER_DSN_RE,
  isValidLocalPort,
} from '../../../instance-validation';
import { OperationLog, operationTone } from './OperationLog';
import { VersionSelect } from './VersionSelect';
import { useManagerSseConnected } from './manager-sse-status';

const PHASES = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'preflight', label: 'Preflight' },
  { id: 'basics', label: 'Basics' },
  { id: 'address', label: 'Address' },
  { id: 'release', label: 'Release' },
  { id: 'review', label: 'Review' },
] as const;

type PhaseIndex = 0 | 1 | 2 | 3 | 4 | 5;

const PREFLIGHT_ORDER = ['docker', 'internet', 'registry', 'resources'] as const;

function preflightStatus(result: CheckResult | undefined, running: boolean): CheckStatus {
  if (running) return 'running';
  if (!result) return 'pending';
  if (!result.ok || result.severity === 'error') return 'error';
  if (result.severity === 'warning') return 'warning';
  return 'ok';
}

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
  const [step, setStep] = useState<PhaseIndex>(0);
  const [displayName, setDisplayName] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [mailerDsn, setMailerDsn] = useState('');
  const [mode, setMode] = useState<'local' | 'production'>('production');
  const [domain, setDomain] = useState('');
  const [localPort, setLocalPort] = useState('9100');
  const [letsencryptEmail, setLetsencryptEmail] = useState('');
  const [useTestChannel, setUseTestChannel] = useState(false);
  const [version, setVersion] = useState('latest');
  /** Set once the install operation started — switches to the log view. */
  const [operationId, setOperationId] = useState<string | null>(null);

  // Is this the FIRST instance (fresh server)? Drives the welcome copy and
  // the Let's Encrypt contact field — the first production install also sets
  // up the shared proxy.
  const serverStatusQuery = useQuery({ queryKey: ['manager', 'server-status'], queryFn: () => client.getServerStatus() });
  const isFirstInstall = serverStatusQuery.data ? !serverStatusQuery.data.initialized : false;

  // Stateless preflight (docker / internet / registry / resources).
  const preflight = useMutation({
    mutationFn: () => client.runPreflight({ mode }),
  });
  const preflightData: PreflightResult | null = preflight.data ?? null;
  const preflightMutate = preflight.mutate;

  // Auto-run the checks when the operator reaches the preflight step.
  useEffect(() => {
    if (step === 1) preflightMutate();
  }, [step, preflightMutate]);

  const preflightOk =
    preflightData !== null && PREFLIGHT_ORDER.every((k) => preflightData[k].ok);

  const onName = (value: string): void => {
    // Auto-suggest the id while the operator hasn't customised it.
    const autoLinked = !instanceId || instanceId === slugify(displayName);
    setDisplayName(value);
    if (autoLinked) setInstanceId(slugify(value));
  };

  // Per-field errors (shown only after the operator typed something).
  const idError =
    instanceId !== '' && !INSTANCE_ID_RE.test(instanceId)
      ? 'Lowercase letters, digits and dashes only (must start alphanumeric).'
      : undefined;
  const emailError = adminEmail !== '' && !EMAIL_RE.test(adminEmail) ? 'Enter a valid email address.' : undefined;
  const mailerError =
    mailerDsn !== '' && !MAILER_DSN_RE.test(mailerDsn)
      ? 'Use a DSN like smtp://user:pass@mail.example.org:587 (leave empty for the bundled test mailbox).'
      : undefined;
  const domainError =
    domain !== '' && !HOSTNAME_RE.test(domain) ? 'Enter a bare hostname, e.g. site.example.org (no scheme, no slash).' : undefined;
  const portNumber = Number(localPort);
  const portError =
    localPort !== '' && !isValidLocalPort(portNumber) ? 'Port must be a number between 1024 and 65535.' : undefined;
  const letsencryptError =
    letsencryptEmail !== '' && !EMAIL_RE.test(letsencryptEmail) ? 'Enter a valid email address.' : undefined;

  const stepReady: Record<PhaseIndex, boolean> = {
    0: true,
    1: preflightOk,
    2: displayName.trim() !== '' && instanceId !== '' && !idError && adminEmail !== '' && !emailError && !mailerError,
    3:
      mode === 'production'
        ? domain !== '' && !domainError && !letsencryptError
        : localPort !== '' && !portError,
    4: version.trim() !== '',
    5: true,
  };

  const request: CreateInstanceRequest = {
    instanceId,
    displayName: displayName.trim(),
    mode,
    registryUrl: preflightData?.registryUrl ?? '',
    adminEmail,
    ...(mode === 'production' ? { domain } : { localPort: portNumber }),
    ...(version.trim() !== '' && version.trim() !== 'latest' ? { version: version.trim() } : {}),
    ...(useTestChannel ? { channel: 'test' } : {}),
    ...(adminName.trim() !== '' ? { adminName: adminName.trim() } : {}),
    ...(mailerDsn.trim() !== '' ? { mailerDsn: mailerDsn.trim() } : {}),
    ...(isFirstInstall && mode === 'production' && letsencryptEmail.trim() !== ''
      ? { letsencryptEmail: letsencryptEmail.trim() }
      : {}),
  };

  const start = useMutation({
    mutationFn: (req: CreateInstanceRequest) => client.createInstance(req),
    onSuccess: (res) => {
      setOperationId(res.operationId);
      onStarted(res.operationId);
    },
  });

  // Watch the running install (shares the cache entry with OperationLog below).
  // SSE pushes install progress live; the 2s poll only runs while the stream is
  // down AND the install is still running.
  const sseConnected = useManagerSseConnected();
  const operationQuery = useQuery({
    queryKey: ['manager', 'operation', operationId ?? 'none'],
    queryFn: () => client.getOperation(operationId!),
    enabled: operationId !== null,
    refetchInterval: (q) => (!sseConnected && q.state.data?.status === 'running' ? 2_000 : false),
  });
  const opStatus = operationQuery.data?.status ?? null;

  const publicAddress = mode === 'production' ? `https://${domain || 'your-domain.example'}` : `http://localhost:${localPort || '…'}`;

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

  function renderWelcome(): JSX.Element {
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

  function renderPreflight(): JSX.Element {
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

  function renderBasics(): JSX.Element {
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

  function renderAddress(): JSX.Element {
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

  function renderRelease(): JSX.Element {
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

  function renderReview(): JSX.Element {
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

  function renderStep(): JSX.Element {
    switch (step) {
      case 0:
        return renderWelcome();
      case 1:
        return renderPreflight();
      case 2:
        return renderBasics();
      case 3:
        return renderAddress();
      case 4:
        return renderRelease();
      default:
        return renderReview();
    }
  }

  function renderProgress(): JSX.Element {
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
        renderProgress()
      )}
    </Stack>
  );
}
