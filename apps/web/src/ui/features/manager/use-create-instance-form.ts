// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * State + logic for the create-instance wizard: every field, the per-field
 * validation (the SAME shared `instance-validation` rules the BFF route runs),
 * the step-ready gates, the assembled {@link CreateInstanceRequest}, the
 * preflight/start mutations and the watched install operation.
 *
 * The step components and the orchestrator read this single object, so the
 * wizard view stays a thin composition. Behaviour is unchanged from the prior
 * in-component implementation.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api-client';
import { slugify } from '../../lib/formatting';
import type { CreateInstanceRequest, PreflightResult } from '../../lib/types';
import { EMAIL_RE, HOSTNAME_RE, INSTANCE_ID_RE, MAILER_DSN_RE, isValidLocalPort } from '../../../instance-validation';
import { useManagerSseConnected } from './manager-sse-status';

export type PhaseIndex = 0 | 1 | 2 | 3 | 4 | 5;

export const PREFLIGHT_ORDER = ['docker', 'internet', 'registry', 'resources'] as const;

export type CreateInstanceForm = ReturnType<typeof useCreateInstanceForm>;

export function useCreateInstanceForm(client: ApiClient, onStarted: (operationId: string) => void) {
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

  const preflightOk = preflightData !== null && PREFLIGHT_ORDER.every((k) => preflightData[k].ok);

  // Detect leftover state (Docker volumes / instance dir) from a PREVIOUS,
  // not-fully-removed install of this id so the wizard can warn before
  // reinstalling. Debounced so typing the id does not hammer the server's
  // `docker volume inspect`, and only queried for a syntactically valid id.
  const [debouncedId, setDebouncedId] = useState('');
  useEffect(() => {
    const valid = instanceId !== '' && INSTANCE_ID_RE.test(instanceId);
    const handle = setTimeout(() => setDebouncedId(valid ? instanceId : ''), 400);
    return () => clearTimeout(handle);
  }, [instanceId]);
  const orphansQuery = useQuery({
    queryKey: ['manager', 'orphans', debouncedId],
    queryFn: () => client.scanOrphans(debouncedId),
    enabled: debouncedId !== '',
  });
  const orphans = orphansQuery.data ?? null;
  const cleanupOrphans = useMutation({
    mutationFn: () => client.cleanupOrphans(debouncedId),
    onSuccess: () => orphansQuery.refetch(),
  });

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

  return {
    client,
    step,
    setStep,
    displayName,
    instanceId,
    setInstanceId,
    adminEmail,
    setAdminEmail,
    adminName,
    setAdminName,
    mailerDsn,
    setMailerDsn,
    mode,
    setMode,
    domain,
    setDomain,
    localPort,
    setLocalPort,
    letsencryptEmail,
    setLetsencryptEmail,
    useTestChannel,
    setUseTestChannel,
    version,
    setVersion,
    operationId,
    setOperationId,
    isFirstInstall,
    preflight,
    preflightData,
    preflightOk,
    onName,
    orphans,
    orphansQuery,
    cleanupOrphans,
    idError,
    emailError,
    mailerError,
    domainError,
    portError,
    letsencryptError,
    stepReady,
    request,
    start,
    operationQuery,
    opStatus,
    publicAddress,
  };
}
