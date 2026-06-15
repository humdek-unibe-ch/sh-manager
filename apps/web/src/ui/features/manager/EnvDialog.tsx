// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Edit an instance's non-secret runtime environment (`.env`).
 *
 * Operators can tune editable variables (JWT TTLs, FRONTEND_BASE_URL, CORS,
 * APP_DEBUG, …) and add their own custom variables. Manager-owned structural
 * keys (instance id, internal Docker URLs, JWT key paths, plugin trust, the
 * MAILER_DSN) are shown read-only — a wrong value there would break networking,
 * auth, or the plugin catalogue, and a real SMTP DSN belongs in the dedicated
 * "Email" flow (stored in the restricted secrets file, never the plain `.env`).
 *
 * Overrides are persisted on the manifest by the BFF, so they survive every
 * later regeneration (update/clone/address change). Applying recreates the
 * containers (BFF job layer: 202 + journaled log). Secrets are never shown.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Code, Divider, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, TextField } from '../../components';
import { ApiError, type ApiClient } from '../../lib/api-client';
import type { InstanceEnvEntry } from '../../lib/types';

export interface EnvDialogProps {
  client: ApiClient;
  instanceId: string;
  opened: boolean;
  onClose: () => void;
  onStarted: (operationId: string) => void;
}

interface EditableRow {
  /** Stable React key (custom rows have no settled name yet). */
  id: number;
  key: string;
  value: string;
  /** Generated default; absent for operator-added custom keys. */
  defaultValue?: string;
  managed: boolean;
  custom: boolean;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function toRows(entries: InstanceEnvEntry[]): EditableRow[] {
  return entries.map((e, i) => ({
    id: i,
    key: e.key,
    value: e.value,
    ...(e.defaultValue !== undefined ? { defaultValue: e.defaultValue } : {}),
    managed: e.managed,
    custom: e.custom,
  }));
}

export function EnvDialog({ client, instanceId, opened, onClose, onStarted }: EnvDialogProps): JSX.Element {
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [nextId, setNextId] = useState(1000);
  const [showManaged, setShowManaged] = useState(false);

  const config = useQuery({
    queryKey: ['manager', 'instance', instanceId, 'env'],
    queryFn: () => client.getInstanceEnv(instanceId),
    enabled: opened,
  });

  // Seed the editable rows once per open. Guarded so a background refetch
  // (e.g. window focus) can never wipe in-progress edits.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!opened) {
      seededRef.current = false;
      return;
    }
    if (config.data && !seededRef.current) {
      setRows(toRows(config.data.entries));
      setShowManaged(false);
      seededRef.current = true;
    }
  }, [opened, config.data]);

  const editable = rows.filter((r) => !r.managed);
  const managed = rows.filter((r) => r.managed);
  const managedKeys = useMemo(() => new Set(config.data?.managedKeys ?? []), [config.data]);

  function update(id: number, patch: Partial<EditableRow>): void {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function addCustom(): void {
    setRows((prev) => [...prev, { id: nextId, key: '', value: '', managed: false, custom: true }]);
    setNextId((n) => n + 1);
  }
  function removeRow(id: number): void {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  // Client-side mirror of the server's validation so Save never sends a request
  // the BFF would reject.
  const errors = useMemo(() => {
    const out = new Map<number, string>();
    const seen = new Map<string, number>();
    for (const row of editable) {
      const key = row.key.trim();
      if (row.custom) {
        if (key === '' && row.value === '') continue; // ignore blank scratch rows
        if (!KEY_RE.test(key)) {
          out.set(row.id, 'Use letters, digits, and underscores; cannot start with a digit.');
          continue;
        }
        if (managedKeys.has(key)) {
          out.set(row.id, 'This key is managed by the manager and cannot be set here.');
          continue;
        }
      }
      if (/[\r\n]/.test(row.value)) {
        out.set(row.id, 'The value must be a single line.');
        continue;
      }
      const prior = seen.get(key);
      if (prior !== undefined) out.set(row.id, `Duplicate key "${key}".`);
      seen.set(key, row.id);
    }
    return out;
  }, [editable, managedKeys]);

  const overrides = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of editable) {
      const key = row.key.trim();
      if (row.custom) {
        if (key === '') continue;
        out[key] = row.value;
      } else if (row.value !== row.defaultValue) {
        out[key] = row.value;
      }
    }
    return out;
  }, [editable]);

  const save = useMutation({
    mutationFn: () => client.setInstanceEnv(instanceId, { overrides }),
    onSuccess: (res) => {
      onClose();
      onStarted(res.operationId);
    },
  });

  const hasErrors = errors.size > 0;

  return (
    <Modal opened={opened} onClose={onClose} title={`Environment of ${instanceId}`} size="xl" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Edit the instance's non-secret runtime configuration. Changes are saved as overrides that
          survive future updates. Secrets are never shown here — configure outbound SMTP through the{' '}
          <strong>Email</strong> dialog.
        </Text>

        {config.isPending ? (
          <Text size="sm">Loading current environment…</Text>
        ) : config.isError ? (
          <Alert tone="error" title="Could not load the environment">
            {config.error instanceof ApiError ? config.error.message : 'The manager service did not answer.'}
          </Alert>
        ) : (
          <>
            <ScrollArea.Autosize mah={380} type="auto">
              <Stack gap="sm" pr="sm">
                {editable.map((row) => {
                  const changed = row.custom ? true : row.value !== row.defaultValue;
                  return (
                    <Group key={row.id} align="flex-end" gap="sm" wrap="nowrap">
                      {row.custom ? (
                        <TextField
                          label="Name"
                          value={row.key}
                          onChange={(v) => update(row.id, { key: v })}
                          placeholder="MY_CUSTOM_VAR"
                        />
                      ) : (
                        <div style={{ minWidth: 240 }}>
                          <Group gap={6} mb={2}>
                            <Code>{row.key}</Code>
                            {changed ? (
                              <Badge size="xs" color="yellow" variant="light">
                                modified
                              </Badge>
                            ) : null}
                          </Group>
                        </div>
                      )}
                      <div style={{ flex: 1 }}>
                        <TextField
                          label={row.custom ? 'Value' : ''}
                          value={row.value}
                          onChange={(v) => update(row.id, { value: v })}
                          {...(errors.get(row.id) ? { error: errors.get(row.id)! } : {})}
                        />
                      </div>
                      {row.custom ? (
                        <Button variant="ghost" onClick={() => removeRow(row.id)}>
                          Remove
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          disabled={!changed}
                          onClick={() => update(row.id, { value: row.defaultValue ?? '' })}
                        >
                          Reset
                        </Button>
                      )}
                    </Group>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>

            <Group justify="space-between">
              <Button variant="secondary" onClick={addCustom}>
                Add variable
              </Button>
              <Button variant="ghost" onClick={() => setShowManaged((s) => !s)}>
                {showManaged ? 'Hide' : 'Show'} managed variables ({managed.length})
              </Button>
            </Group>

            {showManaged ? (
              <>
                <Divider label="Managed by the manager (read-only)" labelPosition="center" />
                <ScrollArea.Autosize mah={220} type="auto">
                  <Stack gap="xs" pr="sm">
                    {managed.map((row) => (
                      <Group key={row.id} gap="sm" wrap="nowrap" justify="space-between">
                        <Code>{row.key}</Code>
                        <Text size="sm" c="dimmed" style={{ wordBreak: 'break-all' }}>
                          {row.value}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
                <Text size="xs" c="dimmed">
                  These keys are derived from the instance identity, internal networking, JWT key paths,
                  and plugin trust. They cannot be edited here.
                </Text>
              </>
            ) : null}

            <Alert tone="info" title="The instance restarts automatically">
              Saving rewrites the instance's <Code>.env</Code> and recreates the containers so every
              service picks up the new values.
            </Alert>

            {save.isError ? (
              <Alert tone="error" title="Could not apply the environment">
                {save.error instanceof ApiError ? save.error.message : 'The manager service did not answer.'}
              </Alert>
            ) : null}

            <Group justify="flex-end" gap="sm">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={hasErrors} loading={save.isPending} onClick={() => save.mutate()}>
                Apply &amp; restart
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
