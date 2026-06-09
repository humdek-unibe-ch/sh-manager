// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared TS-side helpers for the manager Docker e2e: disposable manager root,
 * real `ActionDeps` wired to the OS/Docker boundary (with test-friendly tuning),
 * HTTP probing against the live stack, admin login, and best-effort teardown.
 *
 * The standalone steps (build images, build + serve the test registry) live in
 * the sibling `.mjs` scripts so they are also runnable from the rehearsal
 * runbook; this module is the part that needs the typed manager packages.
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ComposeResult, ComposeRunner } from '@shm/docker';
import { instancePaths } from '@shm/instances';
import type { ActionDeps } from '../apps/cli/src/actions.js';
import { loadTrustedKeys, realDeps } from '../apps/cli/src/env.js';

const execFileAsync = promisify(execFile);

/** Heavy Docker e2e runs only when explicitly opted in (CI workflow / operator). */
export const E2E_ENABLED = process.env.SHM_E2E === '1';

export async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'shm-e2e-'));
}

export async function rmRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/**
 * The e2e images are built locally with a fixed `:e2e` tag and never published,
 * so the update flow's `docker compose pull` (which would hit ghcr.io) must be a
 * no-op. Everything else passes through to the real runner. This is the ONLY
 * deviation from production behaviour and it never hides a real failure: `up -d`
 * still recreates the containers from the locally-present images.
 */
function localImageRunner(base: ComposeRunner): ComposeRunner {
  return {
    run(cwd: string, args: string[]): Promise<ComposeResult> {
      if (args[0] === 'pull') {
        return Promise.resolve({ stdout: '', stderr: 'e2e: skipped pull (local :e2e images)' });
      }
      return base.run(cwd, args);
    },
  };
}

/**
 * The production `probeHealth` is single-shot; the update flow re-probes once,
 * immediately after `docker compose up -d` recreates the (stopped) frontend +
 * backend. On a cold CI runner Next.js needs a few seconds to boot, so a single
 * probe would race the restart and trigger an unwanted rollback. The e2e wraps
 * the real probe in a bounded retry so the SAME `executeUpdate` orchestration is
 * exercised against a stack that has finished booting. Forced-failure scenarios
 * replace `probeHealth` wholesale, so this patience never masks them.
 */
function patientProbe(base: ActionDeps): ActionDeps['probeHealth'] {
  return async (publicUrl, apiPrefix) => {
    const deadline = Date.now() + 180000;
    let last = await base.probeHealth(publicUrl, apiPrefix);
    while (Date.now() < deadline && last.some((p) => !p.ok)) {
      await new Promise((r) => setTimeout(r, 3000));
      last = await base.probeHealth(publicUrl, apiPrefix);
    }
    return last;
  };
}

/** Real deps with a smaller RSA modulus + a generous DB-readiness budget for CI. */
export async function e2eDeps(root: string, trustedKeysPath: string): Promise<ActionDeps> {
  const trustedKeys = await loadTrustedKeys(trustedKeysPath);
  const base = realDeps(root, trustedKeys);
  return {
    ...base,
    runner: localImageRunner(base.runner),
    probeHealth: patientProbe(base),
    jwtModulusLength: 2048,
    dbWaitAttempts: 150,
    dbWaitDelayMs: 2000,
  };
}

export interface HttpResult {
  status: number;
  ok: boolean;
  // Parsed JSON body (null when the body is empty or not JSON).
  json: any;
  text: string;
}

export async function httpJson(
  method: string,
  url: string,
  opts: { token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The e2e talks to the backend DIRECTLY (a host-published port), never through
 * the Next.js BFF: the BFF enforces CSRF on writes, replaces `Authorization`
 * with the session-cookie token, and strips tokens from the login body. The
 * backend API itself has CSRF disabled (it is a bearer-token API), so direct
 * calls with `Authorization: Bearer <jwt>` are the faithful client model. The
 * BFF path is still exercised separately via the manager's own health probe
 * (`instanceHealth`), which hits `<publicFrontendUrl>/api/health` (the BFF maps
 * the BFF-relative path to the backend's `/cms-api/v1/health`).
 */
export function backendHealthUrl(backendBase: string): string {
  return `${backendBase}/cms-api/v1/health`;
}

/** Poll the (direct) backend health endpoint until HTTP 200 or timeout. */
export async function waitForBackendHealthy(backendBase: string, timeoutMs = 240000): Promise<void> {
  const url = backendHealthUrl(backendBase);
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const r = await httpJson('GET', url, { timeoutMs: 8000 });
      if (r.status === 200) return;
      last = `HTTP ${r.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(3000);
  }
  throw new Error(`backend not healthy at ${url} within ${timeoutMs}ms (last: ${last})`);
}

/** Log in as the CMS admin directly against the backend; returns the JWT access token. */
export async function loginAdmin(backendBase: string, email: string, password: string): Promise<string> {
  const r = await httpJson('POST', `${backendBase}/cms-api/v1/auth/login`, { body: { email, password } });
  const token = r.json?.data?.access_token;
  if (r.status !== 200 || typeof token !== 'string' || token.length === 0) {
    throw new Error(`admin login failed at ${backendBase}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }
  return token;
}

/**
 * Best-effort Docker teardown for one disposable test instance: `compose down -v
 * --remove-orphans`. This deliberately bypasses the manager's compose runner
 * (which refuses `down -v` to protect production volumes) by invoking docker
 * directly — these are throwaway e2e instances whose volumes MUST be reaped.
 */
export async function composeDownQuietly(deps: ActionDeps, instanceId: string): Promise<void> {
  try {
    const dir = instancePaths(instanceId, deps.root).dir;
    await execFileAsync('docker', ['compose', 'down', '-v', '--remove-orphans'], { cwd: dir });
  } catch {
    // teardown is best effort; ignore failures (instance may not exist / be up).
  }
}

/**
 * Publish the backend's internal port (8080) to a host port via a compose
 * override and recreate the stack so the e2e can call the backend directly.
 * Returns the backend base URL (`http://127.0.0.1:<hostPort>`). The override is
 * a default compose file (`compose.override.yaml`) auto-merged by `up -d`.
 */
export async function exposeBackend(deps: ActionDeps, instanceId: string, hostPort: number): Promise<string> {
  const paths = instancePaths(instanceId, deps.root);
  const override = `services:\n  backend:\n    ports:\n      - "127.0.0.1:${hostPort}:8080"\n`;
  await writeFile(path.join(paths.dir, 'compose.override.yaml'), override, 'utf8');
  await deps.runner.run(paths.dir, ['up', '-d']);
  return `http://127.0.0.1:${hostPort}`;
}

/**
 * Enable the CMS<->Manager update loop by appending the per-instance
 * `SELFHELP_MANAGER_TOKEN` to the 0600 secret env file and recreating the
 * backend so it reads it. Mirrors the operator step the `services.yaml` comment
 * describes; the token is never stored in the manifest/lock/inventory.
 */
export async function setManagerToken(deps: ActionDeps, instanceId: string, token: string): Promise<void> {
  const paths = instancePaths(instanceId, deps.root);
  await appendFile(path.join(paths.secretsDir, 'secrets.env'), `SELFHELP_MANAGER_TOKEN=${token}\n`, 'utf8');
  await deps.runner.run(paths.dir, ['up', '-d', '--force-recreate', 'backend']);
}
