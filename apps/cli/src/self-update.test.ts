// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { checkSelfUpdate, formatSelfUpdate, selfUpdateInstructions } from './self-update.js';

function fakeFetch(status: number, body: unknown) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe('manager self-update check', () => {
  it('reports an available update with docker pull instructions for the image runtime', async () => {
    const check = await checkSelfUpdate({
      currentVersion: '0.1.3',
      runtime: 'docker',
      fetchImpl: fakeFetch(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/humdek-unibe-ch/sh-manager/releases/tag/v0.2.0' }),
    });
    expect(check.updateAvailable).toBe(true);
    expect(check.latestVersion).toBe('0.2.0');
    expect(check.releaseUrl).toContain('/releases/tag/v0.2.0');
    expect(check.instructions[0]).toBe('docker pull ghcr.io/humdek-unibe-ch/sh-manager:v0.2.0');
    expect(formatSelfUpdate(check)).toContain('Update available: 0.2.0');
  });

  it('reports up to date (no instructions) when the latest release equals the running version', async () => {
    const check = await checkSelfUpdate({
      currentVersion: '0.1.4',
      runtime: 'source',
      fetchImpl: fakeFetch(200, { tag_name: 'v0.1.4' }),
    });
    expect(check.updateAvailable).toBe(false);
    expect(check.instructions).toEqual([]);
    expect(formatSelfUpdate(check)).toContain('Up to date');
  });

  it('gives git+npm instructions for a source checkout', () => {
    expect(selfUpdateInstructions('source', '0.2.0')).toEqual(['git pull', 'npm ci', 'npm run build']);
  });

  it('degrades to an error result (never a throw) when the release feed is unreachable', async () => {
    const check = await checkSelfUpdate({
      currentVersion: '0.1.4',
      runtime: 'docker',
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(check.latestVersion).toBeNull();
    expect(check.updateAvailable).toBe(false);
    expect(check.error).toContain('offline');
    expect(formatSelfUpdate(check)).toContain('Check https://github.com/humdek-unibe-ch/sh-manager/releases manually.');
  });

  it('treats a non-2xx feed answer and an unparseable tag as unresolved', async () => {
    const rateLimited = await checkSelfUpdate({ currentVersion: '0.1.4', runtime: 'docker', fetchImpl: fakeFetch(403, {}) });
    expect(rateLimited.error).toContain('HTTP 403');
    const garbage = await checkSelfUpdate({ currentVersion: '0.1.4', runtime: 'docker', fetchImpl: fakeFetch(200, { tag_name: 'not-a-version' }) });
    expect(garbage.error).toContain('Could not parse');
  });

  it('never claims an update when the running build is ahead of the latest release', async () => {
    const check = await checkSelfUpdate({ currentVersion: '0.3.0', runtime: 'source', fetchImpl: fakeFetch(200, { tag_name: 'v0.2.0' }) });
    expect(check.updateAvailable).toBe(false);
  });
});
