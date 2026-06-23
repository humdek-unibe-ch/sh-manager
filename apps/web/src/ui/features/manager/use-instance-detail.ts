// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Data hook for the instance detail page: all the live queries (detail,
 * operations, watched operation, core/frontend update checks, live plugins),
 * the health-check mutation, the cross-query refresh + finished-operation
 * notification, and the derived view-model (component rows, plugin rows,
 * update availability). Keeping this out of the component leaves the page as a
 * thin composition of presentational cards.
 *
 * Behaviour is unchanged from the previous in-component implementation: the
 * query keys, intervals, invalidations and derived values are identical.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { ApiClient } from '../../lib/api-client';
import { usePagination } from '../../lib/use-pagination';
import { operationKindLabel } from '../../lib/operation-steps';
import { INSTANCES_KEY } from './InstancesList';
import { managerFallbackInterval, useManagerSseConnected } from './manager-sse-status';

export function useInstanceDetail(client: ApiClient, instanceId: string) {
  const [watchedOperationId, setWatchedOperationId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // SSE-driven: the `/api/events` stream invalidates these queries live, so the
  // fallback poll only runs while the stream is disconnected.
  const sseConnected = useManagerSseConnected();

  const detailQuery = useQuery({
    queryKey: ['manager', 'instance', instanceId],
    queryFn: () => client.getInstance(instanceId),
    refetchInterval: managerFallbackInterval(sseConnected, 10_000),
  });

  const operationsQuery = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'operations'],
    queryFn: () => client.listOperations(instanceId),
    refetchInterval: managerFallbackInterval(sseConnected, 5_000),
  });

  // Watch the in-progress operation here too (shares <OperationLog/>'s query
  // key, so it's a single poll). The moment it reaches a terminal state we
  // refresh EVERY query scoped to this instance — detail, operations, backups,
  // schedule, mailer, env — so the whole view reflects the new state without
  // waiting for the next interval tick, and the operator gets a toast. The poll
  // only runs while SSE is down AND the operation is still running.
  const watchedQuery = useQuery({
    queryKey: ['manager', 'operation', watchedOperationId],
    queryFn: () => client.getOperation(watchedOperationId!),
    enabled: watchedOperationId !== null,
    refetchInterval: (q) => (!sseConnected && q.state.data?.status === 'running' ? 2_000 : false),
  });

  const refreshInstance = (): void => {
    // Prefix-invalidate the detail AND every sub-query (operations/backups/
    // schedule/mailer/env all share this prefix)…
    void queryClient.invalidateQueries({ queryKey: ['manager', 'instance', instanceId] });
    // …the live plugins (separate key, so refresh it explicitly)…
    void queryClient.invalidateQueries({ queryKey: ['manager', 'plugins', instanceId] });
    // …and the left-hand instances list, whose display name / version / status
    // this view changes (rename, update, address, remove) — otherwise the list
    // stays stale until a full page reload.
    void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
  };

  const notifiedOpRef = useRef<string | null>(null);
  useEffect(() => {
    const op = watchedQuery.data;
    if (!op || op.status === 'running') return;
    if (notifiedOpRef.current === op.id) return;
    notifiedOpRef.current = op.id;
    void queryClient.invalidateQueries({ queryKey: ['manager', 'instance', instanceId] });
    // A finished operation may have changed the installed plugins (install/
    // uninstall/purge/update) — refresh the live list too.
    void queryClient.invalidateQueries({ queryKey: ['manager', 'plugins', instanceId] });
    // Refresh the left-hand list too: a finished rename/update/address change is
    // visible there (name, version, status), not just on this detail page.
    void queryClient.invalidateQueries({ queryKey: INSTANCES_KEY });
    const label = operationKindLabel(op.kind);
    if (op.status === 'succeeded') {
      notifications.show({ color: 'teal', title: 'Operation finished', message: `${label} completed.` });
    } else if (op.status === 'failed') {
      notifications.show({
        color: 'red',
        title: 'Operation failed',
        message: op.error ?? `${label} failed.`,
        autoClose: 8_000,
      });
    }
  }, [watchedQuery.data, instanceId, queryClient]);

  const health = useMutation({ mutationFn: () => client.runInstanceHealth(instanceId) });

  // Check for core update availability using dry-run (non-blocking, no user input)
  const coreUpdateCheck = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'core-update-check'],
    queryFn: () => client.updateDryRun(instanceId, {}),
    refetchInterval: managerFallbackInterval(sseConnected, 300_000), // Check every 5 minutes
    retry: false,
  });

  // Check for frontend-only update availability
  const frontendUpdateCheck = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'frontend-update-check'],
    queryFn: () => client.frontendUpdateDryRun(instanceId, {}),
    refetchInterval: managerFallbackInterval(sseConnected, 300_000),
    retry: false,
  });

  // Check for mobile-preview-only update availability. The preview is OPTIONAL,
  // so this only runs once the detail load confirms the instance has one
  // installed — instances without a preview never issue the dry-run.
  const hasMobilePreview = Boolean(detailQuery.data?.manifest?.versions.mobilePreview);
  const mobilePreviewUpdateCheck = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'mobile-preview-update-check'],
    queryFn: () => client.mobilePreviewUpdateDryRun(instanceId, {}),
    enabled: hasMobilePreview,
    refetchInterval: hasMobilePreview ? managerFallbackInterval(sseConnected, 300_000) : false,
    retry: false,
  });

  // Live installed plugins, read from the running instance's DB (the source of
  // truth; the manifest's list lags CMS-driven installs). Kept on a SEPARATE
  // key (not the instance prefix) so the chatty SSE log invalidations don't
  // re-exec this heavier docker query on every line; it refreshes on mount, on
  // manual refresh, and when an operation finishes (see below).
  const pluginsQuery = useQuery({
    queryKey: ['manager', 'plugins', instanceId],
    queryFn: () => client.listInstancePlugins(instanceId),
    staleTime: 30_000,
    retry: false,
  });

  const detail = detailQuery.data ?? null;
  const summary = detail?.summary ?? null;
  const busy = summary?.busy != null;
  const operations = operationsQuery.data ?? [];
  const operationsPage = usePagination(operations, 25);
  const manifest = detail?.manifest ?? null;

  // Prefer the LIVE plugin read (the instance's own `plugins` table) over the
  // manifest's recorded list, which lags CMS-driven installs (so the UI showed
  // "no plugins" even with plugins installed). When the instance is down the
  // live read is null → fall back to the manifest (versions only, no enabled
  // state, since that is all the manifest records).
  const livePlugins = pluginsQuery.data;
  const pluginsAreLive = Array.isArray(livePlugins);
  const pluginRows: { id: string; version: string; enabled: boolean | null }[] = pluginsAreLive
    ? livePlugins.map((p) => ({ id: p.id, version: p.version, enabled: p.enabled }))
    : (manifest?.installedPlugins ?? []).map((p) => ({ id: p.id, version: p.version, enabled: null }));
  const pluginsPage = usePagination(pluginRows, 25);

  // Extract update availability + the resolved latest target from the dry-run
  // responses. A core update moves backend/scheduler/worker together (they share
  // the SelfHelp version), so they all report the same "latest".
  const corePlan = coreUpdateCheck.data?.plan as { status: string; targetVersion?: string } | null;
  const coreUpdateAvailable: boolean = corePlan?.status === 'ok' && !!corePlan.targetVersion && corePlan.targetVersion !== manifest?.versions.selfhelp;
  const frontendPlan = frontendUpdateCheck.data?.plan as { status: string; targetFrontendVersion?: string } | null;
  const frontendUpdateAvailable: boolean = frontendPlan?.status === 'ok' && !!frontendPlan.targetFrontendVersion && frontendPlan.targetFrontendVersion !== manifest?.versions.frontend;
  const mobilePreviewPlan = mobilePreviewUpdateCheck.data?.plan as
    | { status: string; targetMobilePreviewVersion?: string }
    | null;
  const mobilePreviewUpdateAvailable: boolean =
    mobilePreviewPlan?.status === 'ok' &&
    !!mobilePreviewPlan.targetMobilePreviewVersion &&
    mobilePreviewPlan.targetMobilePreviewVersion !== manifest?.versions.mobilePreview;

  // The latest version available for a component: the dry-run's target when an
  // update is offered, otherwise the current version when the registry confirms
  // we are up to date, otherwise null (the check is still loading or failed, so
  // we honestly show "—" rather than implying "no update").
  const coreLatest: string | null = corePlan
    ? coreUpdateAvailable
      ? corePlan.targetVersion ?? null
      : corePlan.status === 'up_to_date'
        ? manifest?.versions.selfhelp ?? null
        : null
    : null;
  const frontendLatest: string | null = frontendPlan
    ? frontendUpdateAvailable
      ? frontendPlan.targetFrontendVersion ?? null
      : frontendPlan.status === 'up_to_date'
        ? manifest?.versions.frontend ?? null
        : null
    : null;
  const mobilePreviewLatest: string | null = mobilePreviewPlan
    ? mobilePreviewUpdateAvailable
      ? mobilePreviewPlan.targetMobilePreviewVersion ?? null
      : mobilePreviewPlan.status === 'up_to_date'
        ? manifest?.versions.mobilePreview ?? null
        : null
    : null;

  const anyUpdateAvailable = coreUpdateAvailable || frontendUpdateAvailable || mobilePreviewUpdateAvailable;

  // One row per managed container, pairing the recorded version (where the
  // manifest tracks one) with the resolved image tag/digest, the latest version
  // available, and whether an update is offered.
  const componentRows: {
    label: string;
    version: string | null;
    image: string | null;
    latest?: string | null;
    updateAvailable?: boolean;
  }[] = manifest
    ? [
        { label: 'SelfHelp', version: manifest.versions.selfhelp, image: null, latest: coreLatest, updateAvailable: coreUpdateAvailable },
        { label: 'Backend', version: manifest.versions.backend, image: manifest.images.backend, latest: coreLatest, updateAvailable: coreUpdateAvailable },
        { label: 'Frontend', version: manifest.versions.frontend, image: manifest.images.frontend, latest: frontendLatest, updateAvailable: frontendUpdateAvailable },
        // Optional: only instances that opted into the mobile preview carry a
        // version/image for it, so the row appears only when present.
        ...(manifest.versions.mobilePreview && manifest.images.mobilePreview
          ? [
              {
                label: 'Mobile preview',
                version: manifest.versions.mobilePreview,
                image: manifest.images.mobilePreview,
                latest: mobilePreviewLatest,
                updateAvailable: mobilePreviewUpdateAvailable,
              },
            ]
          : []),
        { label: 'Scheduler', version: manifest.versions.scheduler, image: manifest.images.scheduler, latest: coreLatest, updateAvailable: coreUpdateAvailable },
        { label: 'Worker', version: manifest.versions.worker, image: manifest.images.worker, latest: coreLatest, updateAvailable: coreUpdateAvailable },
        { label: 'Plugin API', version: manifest.versions.pluginApi, image: null },
        { label: 'MySQL', version: null, image: manifest.images.mysql },
        { label: 'Redis', version: null, image: manifest.images.redis },
        { label: 'Mercure', version: null, image: manifest.images.mercure },
        // Mailpit is the bundled local test mailbox (axllent/mailpit:latest);
        // it only runs in local mode and is not version-pinned in the manifest.
        ...(summary?.mode === 'local'
          ? [{ label: 'Mailpit', version: null, image: 'axllent/mailpit:latest' }]
          : []),
      ]
    : [];

  const onStarted = (operationId: string): void => {
    setWatchedOperationId(operationId);
    notifiedOpRef.current = null;
    // Pull in the brand-new journal row immediately (don't wait for the tick).
    refreshInstance();
  };

  return {
    detailQuery,
    operationsQuery,
    coreUpdateCheck,
    pluginsQuery,
    health,
    watchedOperationId,
    setWatchedOperationId,
    refreshInstance,
    onStarted,
    detail,
    summary,
    busy,
    operations,
    operationsPage,
    manifest,
    pluginsAreLive,
    pluginRows,
    pluginsPage,
    corePlan,
    frontendPlan,
    mobilePreviewPlan,
    frontendUpdateAvailable,
    mobilePreviewUpdateAvailable,
    hasMobilePreview,
    anyUpdateAvailable,
    componentRows,
  };
}
