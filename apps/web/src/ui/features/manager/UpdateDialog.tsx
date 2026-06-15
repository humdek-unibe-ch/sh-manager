// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * One update window for an instance.
 *
 * The core and the frontend are released independently, but they are NOT
 * updated independently in a way that can leave them incompatible:
 *
 *   - "SelfHelp core" updates the backend/worker/scheduler to the chosen
 *     release AND moves the frontend to a version that release supports — both
 *     in a single operation. There is no "new core, old frontend" outcome to
 *     worry about: the dry-run resolves the matching frontend and the execution
 *     pulls it together with the core.
 *   - "Frontend only" keeps the current core and swaps just the (stateless)
 *     frontend to a newer compatible release — the lightweight path for when
 *     the core is already current but a newer frontend exists.
 *
 * So the two questions an operator has — "do I bump the core (and get a matching
 * frontend)?" or "do I keep the core and just move the frontend?" — are the two
 * modes here. A "new core but keep the old frontend" combination is deliberately
 * not offered, because the core update always brings the frontend it needs.
 *
 * Each mode reuses the exact same, individually-tested form body as the
 * standalone dialogs, so the dry-run gating, migration-risk acknowledgement and
 * MySQL major-upgrade approval are preserved verbatim.
 */
import { useEffect, useState } from 'react';
import { Modal, SegmentedControl, Stack } from '@mantine/core';
import { Alert } from '../../components';
import type { ApiClient } from '../../lib/api-client';
import { InstanceUpdateBody } from './InstanceUpdateDialog';
import { InstanceFrontendUpdateBody } from './InstanceFrontendUpdateDialog';

export type UpdateMode = 'core' | 'frontend';

export interface UpdateDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
  /** Which mode to open on (default: core). */
  initialMode?: UpdateMode;
}

export function UpdateDialog({
  client,
  instanceId,
  opened,
  onClose,
  onStarted,
  initialMode = 'core',
}: UpdateDialogProps): JSX.Element {
  const [mode, setMode] = useState<UpdateMode>(initialMode);

  // Re-arm the requested mode each time the dialog is (re)opened.
  useEffect(() => {
    if (opened) setMode(initialMode);
  }, [opened, initialMode]);

  return (
    <Modal opened={opened} onClose={onClose} title={`Update ${instanceId}`} size="lg" centered>
      <Stack gap="md">
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(v) => setMode(v as UpdateMode)}
          data={[
            { label: 'SelfHelp core (+ matching frontend)', value: 'core' },
            { label: 'Frontend only (keep core)', value: 'frontend' },
          ]}
        />

        <Alert tone="info" title={mode === 'core' ? 'Core and frontend move together' : 'Frontend-only swap'}>
          {mode === 'core'
            ? 'Updating the core also moves the frontend to a release the new core supports — they are upgraded in the same operation, so the instance is never left on an incompatible pair. The dry-run shows the exact core and frontend versions before anything changes.'
            : 'Keeps the current core and swaps only the frontend container to a newer compatible release. No database migration, no maintenance window, all data untouched. Use this when the core is already current but a newer frontend is available.'}
        </Alert>

        {mode === 'core' ? (
          <InstanceUpdateBody client={client} instanceId={instanceId} onClose={onClose} onStarted={onStarted} />
        ) : (
          <InstanceFrontendUpdateBody client={client} instanceId={instanceId} onClose={onClose} onStarted={onStarted} />
        )}
      </Stack>
    </Modal>
  );
}
