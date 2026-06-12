// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from 'vitest';
import { CrossInstanceError } from '@shm/core';
import { RecordingComposeRunner } from '@shm/docker';
import { ComposeExecBackendOperationsClient, HttpBackendOperationsClient } from './operations-client.js';

interface Captured {
  url: string;
  init?: RequestInit;
}

function fakeFetch(captured: Captured[], response: { status: number; body?: unknown }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({ url, ...(init ? { init } : {}) });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body ?? {},
    } as Response;
  });
}

function client(captured: Captured[], response: { status: number; body?: unknown }) {
  return new HttpBackendOperationsClient({
    backendBaseUrl: 'http://backend.internal:8080/',
    managerToken: 'tok-secret',
    instanceId: 'inst-a',
    fetchImpl: fakeFetch(captured, response),
  });
}

const pendingDto = {
  operation_id: 'op_9',
  instance_id: 'inst-a',
  target_version: '8.0.1',
  preflight_id: 'pf_9',
  approval_token: 'tok_9',
  approved_by_user_id: 7,
  accepted_migration_risk: true,
  destructive_migration: false,
};

describe('HttpBackendOperationsClient', () => {
  it('fetches pending with bearer auth + instance header and maps the envelope', async () => {
    const captured: Captured[] = [];
    const c = client(captured, { status: 200, body: { status: 200, data: pendingDto } });

    const op = await c.fetchPending('inst-a');

    expect(captured[0]?.url).toBe('http://backend.internal:8080/cms-api/v1/manager/system/update/pending');
    const headers = captured[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-secret');
    expect(headers['X-SelfHelp-Instance']).toBe('inst-a');
    expect(op).toMatchObject({ operationId: 'op_9', targetVersion: '8.0.1', acceptedMigrationRisk: true });
  });

  it('returns null when nothing is pending (404 or empty data)', async () => {
    const captured: Captured[] = [];
    expect(await client(captured, { status: 404 }).fetchPending('inst-a')).toBeNull();
    expect(await client(captured, { status: 200, body: { status: 200, data: null } }).fetchPending('inst-a')).toBeNull();
  });

  it('refuses to fetch operations for a different instance (client binding)', async () => {
    const captured: Captured[] = [];
    await expect(client(captured, { status: 200 }).fetchPending('inst-other')).rejects.toBeInstanceOf(CrossInstanceError);
    expect(captured).toHaveLength(0);
  });

  it('rejects a backend response carrying another instance id (defense-in-depth)', async () => {
    const captured: Captured[] = [];
    const c = client(captured, { status: 200, body: { status: 200, data: { ...pendingDto, instance_id: 'inst-evil' } } });
    await expect(c.fetchPending('inst-a')).rejects.toBeInstanceOf(CrossInstanceError);
  });

  it('posts status write-backs to the per-operation endpoint with snake_case body', async () => {
    const captured: Captured[] = [];
    const c = client(captured, { status: 200, body: {} });

    await c.postStatus({ operationId: 'op_9', status: 'migration_running', progressPercent: 70, message: 'migrating' });

    expect(captured[0]?.url).toBe('http://backend.internal:8080/cms-api/v1/manager/system/update/op_9/status');
    expect(captured[0]?.init?.method).toBe('POST');
    const body = JSON.parse(captured[0]?.init?.body as string);
    expect(body).toEqual({ status: 'migration_running', progress_percent: 70, message: 'migrating' });
  });
});

describe('ComposeExecBackendOperationsClient', () => {
  const INSTANCE_DIR = '/opt/selfhelp/instances/inst-a';

  function execClient(respond: (args: string[]) => { stdout: string }) {
    const runner = new RecordingComposeRunner((args) => ({ ...respond(args), stderr: '' }));
    const c = new ComposeExecBackendOperationsClient({ runner, instanceDir: INSTANCE_DIR, instanceId: 'inst-a' });
    return { runner, c };
  }

  it('execs php inside the backend container and parses status + JSON envelope', async () => {
    const { runner, c } = execClient(() => ({
      stdout: `200\n${JSON.stringify({ status: 200, data: pendingDto })}`,
    }));

    const op = await c.fetchPending('inst-a');

    const call = runner.calls[0]!;
    expect(call.cwd).toBe(INSTANCE_DIR);
    expect(call.args.slice(0, 3)).toEqual(['exec', '-T', 'backend']);
    expect(call.args).toContain('php');
    // method + path ride as argv, never interpolated into the script.
    expect(call.args).toContain('GET');
    expect(call.args).toContain('/cms-api/v1/manager/system/update/pending');
    expect(op).toMatchObject({ operationId: 'op_9', instanceId: 'inst-a', targetVersion: '8.0.1' });
  });

  it('returns null when nothing is pending (404) and refuses other instances', async () => {
    const { c } = execClient(() => ({ stdout: '404\n{"status":404,"error":"nothing"}' }));
    expect(await c.fetchPending('inst-a')).toBeNull();
    await expect(c.fetchPending('inst-other')).rejects.toBeInstanceOf(CrossInstanceError);
  });

  it('rejects a backend response carrying another instance id (defense-in-depth)', async () => {
    const { c } = execClient(() => ({
      stdout: `200\n${JSON.stringify({ status: 200, data: { ...pendingDto, instance_id: 'inst-evil' } })}`,
    }));
    await expect(c.fetchPending('inst-a')).rejects.toBeInstanceOf(CrossInstanceError);
  });

  it('explains an unconfigured manager token (401) with the backfill remediation', async () => {
    const { c } = execClient(() => ({ stdout: '401\n{"status":401,"error":"Manager loop is not enabled"}' }));
    await expect(c.fetchPending('inst-a')).rejects.toThrow(/repair|backfill/i);
  });

  it('fails clearly when the container/HTTP layer never answered (status 0)', async () => {
    const { c } = execClient(() => ({ stdout: '0\n' }));
    await expect(c.fetchPending('inst-a')).rejects.toThrow(/did not answer/i);
  });

  it('posts status write-backs with the snake_case body as an argv payload', async () => {
    const { runner, c } = execClient(() => ({ stdout: '200\n{"status":200}' }));

    await c.postStatus({ operationId: 'op_9', status: 'update_running', progressPercent: 50 });

    const call = runner.calls[0]!;
    expect(call.args).toContain('POST');
    expect(call.args).toContain('/cms-api/v1/manager/system/update/op_9/status');
    const payload = call.args[call.args.length - 1]!;
    expect(JSON.parse(payload)).toEqual({ status: 'update_running', progress_percent: 50 });
  });
});
