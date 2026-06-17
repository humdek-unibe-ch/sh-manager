// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared harness for the BFF server suites (`server-*.test.ts`). These helpers
 * used to sit at the top of one giant `server.test.ts`; they are factored out
 * here so every per-area suite spins up the SAME fake bootstrap actions, the
 * SAME operator stores and an EPHEMERAL-port test server without copy/paste.
 *
 * Importing this module registers an `afterEach` that closes every server it
 * `start`ed and removes every temp SPA dir it made. Vitest isolates modules per
 * test file, so the tracked `handles`/`tmpDirs` never leak across suites — which
 * is exactly the cleanup the original single-file `afterEach` did.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { createOperator, emptyOperatorTable, InMemoryOperatorStore, type OperatorStore } from '@shm/auth';
import { createManagerServer, type ManagerServerHandle } from './server.js';
import type { BootstrapActions } from './actions.js';

/** Bootstrap checks that all pass — override individual probes per test. */
export function fakeActions(overrides: Partial<BootstrapActions> = {}): BootstrapActions {
  return {
    async checkDocker() {
      return { dockerAvailable: true, dockerComposeAvailable: true };
    },
    async checkInternet() {
      return { ok: true, severity: 'ok' };
    },
    async checkRegistry() {
      return { ok: true, signatureVerified: true };
    },
    async checkResources() {
      return { status: 'ok' };
    },
    ...overrides,
  };
}

/** An operator store with no accounts (first-run / bootstrap state). */
export function emptyStore(): OperatorStore {
  return new InMemoryOperatorStore(emptyOperatorTable());
}

/** An operator store seeded with a single `server_owner` (the login fixtures below). */
export function configuredStore(): OperatorStore {
  const created = createOperator(emptyOperatorTable(), {
    email: 'owner@example.com',
    displayName: 'Owner',
    password: 'correct horse battery staple',
    roles: ['server_owner'],
  });
  return new InMemoryOperatorStore(created.table);
}

/**
 * Test servers always bind an EPHEMERAL port: the fixed default (8765) may be
 * taken on a developer machine by a real running manager GUI, and parallel
 * test files must never fight over one port.
 */
export function testServer(
  options: Partial<Parameters<typeof createManagerServer>[0]> & { actions: BootstrapActions },
): ManagerServerHandle {
  return createManagerServer({ port: 0, operatorStore: configuredStore(), ...options });
}

const handles: ManagerServerHandle[] = [];
const tmpDirs: string[] = [];

/** Start a handle (tracked for teardown) and return its base URL. */
export async function start(handle: ManagerServerHandle): Promise<string> {
  handles.push(handle);
  const { host, port } = await handle.listen();
  const h = host === '::1' ? '[::1]' : host;
  return `http://${h}:${port}`;
}

/** A throwaway built-SPA directory (index.html + a hashed asset) for cache tests. */
export async function makeSpaDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shm-spa-'));
  tmpDirs.push(dir);
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  return dir;
}

/** Log in as the seeded owner (or a given operator) and return cookie + CSRF token. */
export async function login(base: string, email = 'owner@example.com', password = 'correct horse battery staple') {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { cookie, csrfToken };
}

afterEach(async () => {
  await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
  handles.length = 0;
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
  tmpDirs.length = 0;
});
