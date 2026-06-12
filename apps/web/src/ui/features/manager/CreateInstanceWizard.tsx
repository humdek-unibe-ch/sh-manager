// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Create-instance wizard: the same guided step-form experience as the
 * single-instance bootstrap, adapted for the multi-instance console. Opens as
 * a 90%-width modal that never closes by accident (no click-outside / Escape —
 * only Cancel/Close), walks Basics → Address → Release → Review, and then
 * shows the journaled install log INSIDE the modal so the operator gets live
 * feedback instead of a silently-closing dialog.
 *
 * Validation mirrors the server exactly: the step gates reuse the shared
 * `instance-validation` module the BFF route runs, so the wizard can never
 * submit a request the server would reject. The version is picked from the
 * verified release registry (dropdown, no free typing) and the generated
 * admin password never reaches the browser — provisioning writes it to a
 * root-readable file on the server.
 */
import { useEffect, useState } from 'react';
import { Code, Divider, Group, Modal, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  ChoiceCard,
  KeyValue,
  StatusBadge,
  TextField,
  WizardStepper,
} from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import { slugify } from '../../lib/formatting';
import type { CreateInstanceRequest } from '../../lib/types';
import { EMAIL_RE, HOSTNAME_RE, INSTANCE_ID_RE, isValidLocalPort } from '../../../instance-validation';
import { OperationLog, operationTone } from './OperationLog';
import { VersionSelect } from './VersionSelect';

const PHASES = [
  { id: 'basics', label: 'Basics' },
  { id: 'address', label: 'Address' },
  { id: 'release', label: 'Release' },
  { id: 'review', label: 'Review & install' },
] as const;

type PhaseIndex = 0 | 1 | 2 | 3;

export interface CreateInstanceWizardProps {
  client: ApiClient;
  opened: boolean;
  onClose: () => void;
  /** Prefill for the registry URL (from the server snapshot config). */
  defaultRegistryUrl: string;
  /** Called with the started operation id as soon as the install begins. */
  onStarted: (operationId: string) => void;
  /** Called when the operator opens the freshly installed instance. */
  onOpenInstance?: (instanceId: string) => void;
}

export function CreateInstanceWizard({
  client,
  opened,
  onClose,
  defaultRegistryUrl,
  onStarted,
  onOpenInstance,
}: CreateInstanceWizardProps): JSX.Element {
  const [step, setStep] = useState<PhaseIndex>(0);
  const [displayName, setDisplayName] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [mode, setMode] = useState<'local' | 'production'>('production');
  const [domain, setDomain] = useState('');
  const [localPort, setLocalPort] = useState('9100');
  const [useTestChannel, setUseTestChannel] = useState(false);
  const [version, setVersion] = useState('latest');
  /** Set once the install operation started — switches the modal to the log view. */
  const [operationId, setOperationId] = useState<string | null>(null);

  // Fresh form every time the wizard opens.
  useEffect(() => {
    if (!opened) return;
    setStep(0);
    setDisplayName('');
    setInstanceId('');
    setAdminEmail('');
    setAdminName('');
    setMode('production');
    setDomain('');
    setLocalPort('9100');
    setUseTestChannel(false);
    setVersion('latest');
    setOperationId(null);
  }, [opened]);

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
  const domainError =
    domain !== '' && !HOSTNAME_RE.test(domain) ? 'Enter a bare hostname, e.g. site.example.org (no scheme, no slash).' : undefined;
  const portNumber = Number(localPort);
  const portError =
    localPort !== '' && !isValidLocalPort(portNumber) ? 'Port must be a number between 1024 and 65535.' : undefined;

  const stepReady: Record<PhaseIndex, boolean> = {
    0: displayName.trim() !== '' && instanceId !== '' && !idError && adminEmail !== '' && !emailError,
    1: mode === 'production' ? domain !== '' && !domainError : localPort !== '' && !portError,
    2: version.trim() !== '',
    3: true,
  };

  const request: CreateInstanceRequest = {
    instanceId,
    displayName: displayName.trim(),
    mode,
    registryUrl: defaultRegistryUrl,
    adminEmail,
    ...(mode === 'production' ? { domain } : { localPort: portNumber }),
    ...(version.trim() !== '' && version.trim() !== 'latest' ? { version: version.trim() } : {}),
    ...(useTestChannel ? { channel: 'test' } : {}),
    ...(adminName.trim() !== '' ? { adminName: adminName.trim() } : {}),
  };

  const start = useMutation({
    mutationFn: (req: CreateInstanceRequest) => client.createInstance(req),
    onSuccess: (res) => {
      setOperationId(res.operationId);
      onStarted(res.operationId);
    },
  });

  // Watch the running install (shares the cache entry with OperationLog below).
  const operationQuery = useQuery({
    queryKey: ['manager', 'operation', operationId ?? 'none'],
    queryFn: () => client.getOperation(operationId!),
    enabled: operationId !== null,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2_000 : false),
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
          {step < 3 ? (
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
                  <TextField label="Admin name" value={adminName} onChange={setAdminName} placeholder="Optional" />
                </Group>
              </Stack>
            </Paper>
            <Alert tone="info" title="About the admin password">
              The generated admin password is never shown in the browser: it is written to a restricted (0600)
              file on the server and the install log shows the file path — read it over SSH after the install
              finishes.
            </Alert>
          </Stack>
        );
      case 1:
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
                  <TextField
                    label="Domain"
                    value={domain}
                    onChange={setDomain}
                    required
                    placeholder="site.example.org"
                    help="Create the DNS A/AAAA record for this hostname before installing — you can change it later from the instance page."
                    {...(domainError ? { error: domainError } : {})}
                  />
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
      case 2:
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
                value={defaultRegistryUrl}
                onChange={() => undefined}
                disabled
                help="Fixed to the official signed SelfHelp registry."
              />
            </Stack>
          </Paper>
        );
      default:
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
  }

  function renderProgress(): JSX.Element {
    return (
      <Stack gap="md">
        <Group gap="sm">
          {opStatus ? <StatusBadge tone={operationTone(opStatus)}>{opStatus}</StatusBadge> : null}
          <Text size="sm" c="dimmed">
            The install continues on the server even if you close this window — the live log stays available
            on the dashboard.
          </Text>
        </Group>

        <OperationLog client={client} operationId={operationId!} />

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
    <Modal
      opened={opened}
      onClose={onClose}
      size="90%"
      centered
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      padding="xl"
      title={null}
    >
      <Stack gap="lg">
        <Stack gap={4}>
          <Title order={3}>{operationId ? `Installing ${instanceId}` : 'Create a new instance'}</Title>
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
    </Modal>
  );
}
