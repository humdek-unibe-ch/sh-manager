// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Authenticated manager metadata + bootstrap-check endpoints.
 *
 * Split out of the original monolithic `server.test.ts`; the shared BFF
 * harness (fake actions/stores, ephemeral test server, login, SPA dir +
 * cleanup) lives in `server-test-support`. The test bodies are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { fakeActions, login, start, testServer } from './server-test-support.js';

describe('authenticated manager endpoints', () => {
  it('exposes the manager self-update check as GET /api/manager/update-check', async () => {
    const base = await start(
      testServer({
        actions: fakeActions({
          checkManagerUpdate: async () => ({
            currentVersion: '0.1.4',
            latestVersion: '0.2.0',
            updateAvailable: true,
            runtime: 'docker',
            instructions: ['docker pull ghcr.io/humdek-unibe-ch/sh-manager:v0.2.0'],
          }),
        }),
      }),
    );
    const { cookie } = await login(base);
    const res = await fetch(base + '/api/manager/update-check', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updateAvailable: boolean; latestVersion: string };
    expect(body.updateAvailable).toBe(true);
    expect(body.latestVersion).toBe('0.2.0');
  });

  it('lists registry versions against the server-default registry', async () => {
    const calls: { url: string; channel: string; kind: string | undefined }[] = [];
    const base = await start(
      testServer({
        actions: fakeActions({
          listVersions: async (registryUrl, channel, kind) => {
            calls.push({ url: registryUrl, channel, kind });
            return { versions: ['0.2.0', '0.1.0'] };
          },
        }),
        defaultRegistryUrl: 'https://registry.example.com/',
      }),
    );
    const { cookie } = await login(base);
    const res = await fetch(base + '/api/registry/versions', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { versions: string[] }).versions).toEqual(['0.2.0', '0.1.0']);
    expect(calls[0]).toEqual({ url: 'https://registry.example.com/', channel: 'stable', kind: 'core' });

    await fetch(base + '/api/registry/versions?channel=test', { headers: { cookie } });
    expect(calls[1]?.channel).toBe('test');

    // The frontend-only update dialog reads the independent frontend feed.
    await fetch(base + '/api/registry/versions?kind=frontend', { headers: { cookie } });
    expect(calls[2]?.kind).toBe('frontend');
  });

  it('answers /api/state with the manager version and the session identity', async () => {
    const base = await start(testServer({ actions: fakeActions(), managerVersion: '1.0.6' }));
    const { cookie } = await login(base);
    const res = await fetch(base + '/api/state', { headers: { cookie } });
    // The version-bearing state response must be uncacheable, or a browser keeps
    // showing the previous managerVersion after an update (the "still see the old
    // GUI version" report) even across a hard refresh.
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      mode: string;
      managerVersion?: string;
      session?: { email: string };
    };
    expect(body.mode).toBe('persistent');
    expect(body.managerVersion).toBe('1.0.6');
    expect(body.session?.email).toBe('owner@example.com');
  });
});
