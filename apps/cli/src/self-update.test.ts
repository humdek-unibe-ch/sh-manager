// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  applySelfUpdate,
  checkSelfUpdate,
  formatSelfUpdate,
  nextWebImage,
  selfUpdateInstructions,
  type ExecLike,
  type SelfUpdateCheck,
} from './self-update.js';

function fakeFetch(status: number, body: unknown) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe('manager self-update check', () => {
  it('reports an available update with the self-update command + manual pull fallback for the image runtime', async () => {
    const check = await checkSelfUpdate({
      currentVersion: '0.1.3',
      runtime: 'docker',
      fetchImpl: fakeFetch(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/humdek-unibe-ch/sh-manager/releases/tag/v0.2.0' }),
    });
    expect(check.updateAvailable).toBe(true);
    expect(check.latestVersion).toBe('0.2.0');
    expect(check.releaseUrl).toContain('/releases/tag/v0.2.0');
    expect(check.instructions[0]).toContain('sh-manager self-update');
    expect(check.instructions.join('\n')).toContain('docker pull ghcr.io/humdek-unibe-ch/sh-manager:v0.2.0');
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

  it('gives the self-update command + git+npm fallback for a source checkout', () => {
    const lines = selfUpdateInstructions('source', '0.2.0');
    expect(lines[0]).toContain('sh-manager self-update');
    expect(lines.join('\n')).toContain('git pull && npm ci && npm run build');
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

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

interface ExecCall {
  cmd: string;
  args: string[];
  cwd?: string;
}

/** Records every exec; per-prefix canned responses (string = stdout, Error = throw). */
function recordingExec(responses: Record<string, string | Error> = {}): { calls: ExecCall[]; exec: ExecLike } {
  const calls: ExecCall[] = [];
  const exec: ExecLike = async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    const key = `${cmd} ${args.join(' ')}`;
    for (const [prefix, out] of Object.entries(responses)) {
      if (key.startsWith(prefix)) {
        if (out instanceof Error) throw out;
        return { stdout: out, stderr: '' };
      }
    }
    return { stdout: '', stderr: '' };
  };
  return { calls, exec };
}

function dockerCheck(latest = '1.0.11'): SelfUpdateCheck {
  return {
    currentVersion: '1.0.10',
    latestVersion: latest,
    updateAvailable: true,
    runtime: 'docker',
    instructions: [],
  };
}

const WEB_INSPECT_JSON = JSON.stringify({
  Id: 'f00dfeedfacef00dfeedfacef00dfeedfacef00dfeedfacef00dfeedfacef00d',
  Config: {
    Image: 'ghcr.io/humdek-unibe-ch/sh-manager:latest',
    Cmd: ['web', '--host', '0.0.0.0', '--port', '8765'],
    Env: ['PATH=/usr/local/bin', 'NODE_ENV=production', 'SELFHELP_ROOT=/opt/selfhelp', 'SHM_WEB_PERSIST=true'],
  },
  HostConfig: {
    Binds: ['/var/run/docker.sock:/var/run/docker.sock', 'D:\\selfhelp:/opt/selfhelp'],
    PortBindings: { '8765/tcp': [{ HostIp: '127.0.0.1', HostPort: '8765' }] },
    ExtraHosts: ['host.docker.internal:host-gateway'],
    AutoRemove: true,
    RestartPolicy: { Name: 'no' },
  },
});

describe('manager self-update apply (docker runtime)', () => {
  it('pulls the new tags and recreates the web GUI container with its original ports, mounts and args', async () => {
    const { calls, exec } = recordingExec({ 'docker inspect sh-manager-web': WEB_INSPECT_JSON });

    const result = await applySelfUpdate(dockerCheck(), { exec });

    const joined = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(joined).toContain('docker pull ghcr.io/humdek-unibe-ch/sh-manager:v1.0.11');
    expect(joined).toContain('docker pull ghcr.io/humdek-unibe-ch/sh-manager:latest');
    expect(joined).toContain('docker rm -f sh-manager-web');

    const run = calls.find((c) => c.cmd === 'docker' && c.args[0] === 'run');
    expect(run).toBeTruthy();
    const args = run!.args.join(' ');
    expect(args).toContain('-d --name sh-manager-web');
    expect(args).toContain('--rm'); // AutoRemove preserved
    expect(args).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(args).toContain('-v D:\\selfhelp:/opt/selfhelp');
    expect(args).toContain('-p 127.0.0.1:8765:8765');
    expect(args).toContain('--add-host host.docker.internal:host-gateway');
    // Operator-intent env survives; image-provided env does not.
    expect(args).toContain('-e SHM_WEB_PERSIST=true');
    expect(args).toContain('-e SELFHELP_ROOT=/opt/selfhelp');
    expect(args).not.toContain('PATH=');
    // The container ran :latest, which the pull above refreshed.
    expect(args).toContain('ghcr.io/humdek-unibe-ch/sh-manager:latest web --host 0.0.0.0 --port 8765');

    expect(result.applied).toBe(true);
    expect(result.webRestarted).toBe(true);
  });

  it('only pulls when no web GUI container exists', async () => {
    const { calls, exec } = recordingExec({
      'docker inspect sh-manager-web': new Error('Error: No such object: sh-manager-web'),
    });

    const result = await applySelfUpdate(dockerCheck(), { exec });

    expect(result.applied).toBe(true);
    expect(result.webRestarted).toBe(false);
    expect(result.webRestartHint).toBeUndefined();
    expect(calls.some((c) => c.args[0] === 'rm')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'run')).toBe(false);
  });

  it('moves a web container pinned to an official version tag onto the new version tag', () => {
    expect(nextWebImage('ghcr.io/humdek-unibe-ch/sh-manager:v1.0.9', 'ghcr.io/humdek-unibe-ch/sh-manager', '1.0.11')).toBe(
      'ghcr.io/humdek-unibe-ch/sh-manager:v1.0.11',
    );
    expect(nextWebImage('ghcr.io/humdek-unibe-ch/sh-manager:latest', 'ghcr.io/humdek-unibe-ch/sh-manager', '1.0.11')).toBe(
      'ghcr.io/humdek-unibe-ch/sh-manager:latest',
    );
    expect(nextWebImage('my.registry/custom:tag', 'ghcr.io/humdek-unibe-ch/sh-manager', '1.0.11')).toBe('my.registry/custom:tag');
  });

  it('refuses to kill its own container (updater running inside sh-manager-web) and says how to restart', async () => {
    const { calls, exec } = recordingExec({ 'docker inspect sh-manager-web': WEB_INSPECT_JSON });

    const result = await applySelfUpdate(dockerCheck(), { exec, selfContainerId: 'f00dfeedface' });

    expect(result.applied).toBe(true);
    expect(result.webRestarted).toBe(false);
    expect(result.webRestartHint).toContain('not restarted');
    expect(calls.some((c) => c.args[0] === 'rm')).toBe(false);
  });

  it('degrades to a restart hint (never a failed apply) when recreating the GUI container fails', async () => {
    const { exec } = recordingExec({
      'docker inspect sh-manager-web': WEB_INSPECT_JSON,
      'docker run': new Error('port is already allocated'),
    });

    const result = await applySelfUpdate(dockerCheck(), { exec });

    expect(result.applied).toBe(true);
    expect(result.webRestarted).toBe(false);
    expect(result.webRestartHint).toContain('port is already allocated');
  });

  it('fails loudly when the image pull itself fails', async () => {
    const { exec } = recordingExec({ 'docker pull': new Error('manifest unknown') });
    await expect(applySelfUpdate(dockerCheck(), { exec })).rejects.toThrow(/manifest unknown/);
  });
});

describe('manager self-update apply (source runtime)', () => {
  it('runs git pull + npm ci + npm run build in the checkout', async () => {
    const { calls, exec } = recordingExec();
    const check: SelfUpdateCheck = { ...dockerCheck(), runtime: 'source' };

    const result = await applySelfUpdate(check, { exec, repoRoot: '/srv/sh-manager' });

    expect(calls).toEqual([
      { cmd: 'git', args: ['pull', '--ff-only'], cwd: '/srv/sh-manager' },
      { cmd: 'npm', args: ['ci'], cwd: '/srv/sh-manager' },
      { cmd: 'npm', args: ['run', 'build'], cwd: '/srv/sh-manager' },
    ]);
    expect(result.applied).toBe(true);
    expect(result.webRestartHint).toContain('Restart any running `sh-manager web` process');
  });

  it('stops at the first failing step (a dirty checkout must not be built over)', async () => {
    const { calls, exec } = recordingExec({ 'git pull': new Error('not a fast-forward') });
    const check: SelfUpdateCheck = { ...dockerCheck(), runtime: 'source' };

    await expect(applySelfUpdate(check, { exec })).rejects.toThrow(/fast-forward/);
    expect(calls.some((c) => c.cmd === 'npm')).toBe(false);
  });
});
