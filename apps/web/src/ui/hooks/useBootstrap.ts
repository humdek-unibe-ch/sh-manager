// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Drives the bootstrap installer against the BFF. The server is authoritative
 * for wizard state; this hook keeps a thin client mirror plus UI-only concerns
 * (unsaved field draft, in-flight flags, friendly error text). No domain or
 * validation logic is duplicated here — it lives in the server's `wizard.ts`.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { ApiError, createApiClient, type ApiClient } from '../lib/api-client';
import { publicUrlPreview } from '../lib/formatting';
import type { InstallResult, Snapshot, WizardConfig, WizardStepId } from '../lib/types';

export interface BootstrapState {
  status: 'loading' | 'ready' | 'error';
  loadError: string | null;
  snapshot: Snapshot | null;
  draft: Partial<WizardConfig>;
  busy: boolean;
  runningCheck: WizardStepId | null;
  actionError: string | null;
  installing: boolean;
  installError: string | null;
  installResult: InstallResult | null;
}

const INITIAL: BootstrapState = {
  status: 'loading',
  loadError: null,
  snapshot: null,
  draft: {},
  busy: false,
  runningCheck: null,
  actionError: null,
  installing: false,
  installError: null,
  installResult: null,
};

function reducer(state: BootstrapState, patch: Partial<BootstrapState>): BootstrapState {
  return { ...state, ...patch };
}

function friendly(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

export interface BootstrapController {
  state: BootstrapState;
  /** snapshot.config merged with unsaved field edits. */
  effectiveConfig: WizardConfig | null;
  patchDraft: (patch: Partial<WizardConfig>) => void;
  continueStep: () => Promise<void>;
  goBack: () => Promise<void>;
  runCheck: (step: WizardStepId) => Promise<void>;
  install: () => Promise<void>;
  dismissError: () => void;
}

export function useBootstrap(injectedClient?: ApiClient): BootstrapController {
  const client = useMemo(() => injectedClient ?? createApiClient(), [injectedClient]);
  const [state, dispatch] = useReducer(reducer, INITIAL);

  // Live ref so async sequences and the draft updater always read fresh state.
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    try {
      const snapshot = await client.getState();
      dispatch({ status: 'ready', snapshot, loadError: null });
    } catch (err) {
      dispatch({ status: 'error', loadError: friendly(err) });
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchDraft = useCallback((patch: Partial<WizardConfig>) => {
    dispatch({ draft: { ...stateRef.current.draft, ...patch } });
  }, []);

  const continueStep = useCallback(async () => {
    if (!stateRef.current.snapshot) return;
    dispatch({ busy: true, actionError: null });
    try {
      const draft = stateRef.current.draft;
      if (Object.keys(draft).length > 0) await client.setConfig(draft);
      const next = await client.advance();
      dispatch({ snapshot: next, draft: {} });
    } catch (err) {
      dispatch({ actionError: friendly(err) });
    } finally {
      dispatch({ busy: false });
    }
  }, [client]);

  const goBack = useCallback(async () => {
    dispatch({ busy: true, actionError: null });
    try {
      const next = await client.back();
      dispatch({ snapshot: next, draft: {} });
    } catch (err) {
      dispatch({ actionError: friendly(err) });
    } finally {
      dispatch({ busy: false });
    }
  }, [client]);

  const runCheck = useCallback(
    async (step: WizardStepId) => {
      dispatch({ runningCheck: step, actionError: null });
      try {
        const next = await client.runCheck(step);
        dispatch({ snapshot: next });
      } catch (err) {
        dispatch({ actionError: friendly(err) });
      } finally {
        dispatch({ runningCheck: null });
      }
    },
    [client],
  );

  const install = useCallback(async () => {
    dispatch({ installing: true, installError: null, actionError: null });
    try {
      const snap = await client.install();
      const outcome = snap.outcome;
      if (!outcome || !outcome.ok) {
        dispatch({ installing: false, installError: outcome?.detail ?? 'Installation failed.', snapshot: snap });
        return;
      }
      const cfg = { ...snap.config, ...stateRef.current.draft };
      const result: InstallResult = {
        outcome,
        ...(snap.health ? { health: snap.health } : {}),
        publicUrl: snap.publicUrl ?? publicUrlPreview(cfg),
      };
      // Finalize server state: install -> health -> done (tolerate a health block).
      try {
        await client.advance();
        if (snap.health && (snap.health.healthy || snap.health.degraded)) await client.advance();
      } catch {
        // best effort; the success screen relies on the captured result.
      }
      let fresh: Snapshot = snap;
      try {
        fresh = await client.getState();
      } catch {
        // self-lock or transient error — keep the install response snapshot.
      }
      dispatch({ installing: false, installResult: result, snapshot: fresh });
    } catch (err) {
      dispatch({ installing: false, installError: friendly(err) });
    }
  }, [client]);

  const dismissError = useCallback(() => dispatch({ actionError: null }), []);

  const effectiveConfig = useMemo<WizardConfig | null>(
    () => (state.snapshot ? { ...state.snapshot.config, ...state.draft } : null),
    [state.snapshot, state.draft],
  );

  return { state, effectiveConfig, patchDraft, continueStep, goBack, runCheck, install, dismissError };
}
