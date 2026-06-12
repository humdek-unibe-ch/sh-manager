// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { RecordingComposeRunner } from '@shm/docker';
import {
  ComposeExecPluginStateClient,
  composePluginExecDeps,
  parseRunbookCommand,
} from './plugin-state-client.js';

describe('parseRunbookCommand', () => {
  it('extracts package + version from the managed-runbook composer require command', () => {
    expect(parseRunbookCommand('composer require humdek/sh2-shp-survey-js:0.2.22 --no-interaction --no-scripts')).toEqual({
      package: 'humdek/sh2-shp-survey-js',
      version: '0.2.22',
    });
  });

  it('extracts the package from a composer remove command (no version)', () => {
    expect(parseRunbookCommand('composer remove humdek/sh2-shp-survey-js --no-interaction --no-scripts')).toEqual({
      package: 'humdek/sh2-shp-survey-js',
      version: null,
    });
  });

  it('returns nulls for frontend-only operations without a composer command', () => {
    expect(parseRunbookCommand('No composer package to remove (frontend-only plugin).')).toEqual({
      package: null,
      version: null,
    });
  });
});

function clientWith(stdout: string): { client: ComposeExecPluginStateClient; runner: RecordingComposeRunner } {
  const runner = new RecordingComposeRunner(() => ({ stdout, stderr: '' }));
  const client = new ComposeExecPluginStateClient({ runner, instanceDir: '/opt/selfhelp/instances/demo1' });
  return { client, runner };
}

describe('ComposeExecPluginStateClient', () => {
  it('maps parked managed operations (composer command -> coordinates, vcs repository kept)', async () => {
    const { client, runner } = clientWith(
      JSON.stringify([
        {
          operationId: 7,
          pluginId: 'sh2-shp-survey-js',
          type: 'install',
          command: 'composer require humdek/sh2-shp-survey-js:0.2.22 --no-interaction --no-scripts',
          repository: { type: 'vcs', url: 'https://github.com/humdek-unibe-ch/sh2-shp-survey-js.git' },
          archiveBackendDir: null,
          archiveStagingDir: '/app/var/plugins/sh2-shp-survey-js-0.2.22/staging',
        },
      ]),
    );
    const ops = await client.listPendingOperations();
    expect(ops).toEqual([
      {
        operationId: 7,
        pluginId: 'sh2-shp-survey-js',
        type: 'install',
        package: 'humdek/sh2-shp-survey-js',
        version: '0.2.22',
        repository: { type: 'vcs', url: 'https://github.com/humdek-unibe-ch/sh2-shp-survey-js.git' },
        archiveStagingDir: '/app/var/plugins/sh2-shp-survey-js-0.2.22/staging',
      },
    ]);
    // Query runs inside the backend container; mode is argv, never inlined PHP.
    const call = runner.calls[0]!;
    expect(call.cwd).toBe('/opt/selfhelp/instances/demo1');
    expect(call.args.slice(0, 4)).toEqual(['exec', '-T', 'backend', 'php']);
    expect(call.args.slice(-2)).toEqual(['--', 'pending']);
  });

  it('falls back to a composer path repo for standalone archive plugins', async () => {
    const { client } = clientWith(
      JSON.stringify([
        {
          operationId: 3,
          pluginId: 'archive-plugin',
          type: 'update',
          command: 'composer require humdek/archive-plugin:1.2.0 --no-interaction --no-scripts',
          repository: null,
          archiveBackendDir: '/app/var/plugins/archive-plugin-1.2.0/installed/backend/package',
          archiveStagingDir: null,
        },
      ]),
    );
    const ops = await client.listPendingOperations();
    expect(ops[0]).toMatchObject({
      type: 'update',
      repository: { type: 'path', url: '/app/var/plugins/archive-plugin-1.2.0/installed/backend/package' },
    });
  });

  it('maps installed plugin rows, preferring the manifest composer version', async () => {
    const { client } = clientWith(
      JSON.stringify([
        {
          pluginId: 'sh2-shp-survey-js',
          version: '0.2.22',
          enabled: true,
          package: 'humdek/sh2-shp-survey-js',
          composerVersion: '0.2.22',
          repository: { type: 'vcs', url: 'https://github.com/humdek-unibe-ch/sh2-shp-survey-js.git' },
        },
        { pluginId: 'frontend-only', version: '1.0.0', enabled: false, package: null, composerVersion: null, repository: null },
      ]),
    );
    const plugins = await client.listInstalledPlugins();
    expect(plugins).toEqual([
      {
        pluginId: 'sh2-shp-survey-js',
        version: '0.2.22',
        enabled: true,
        package: 'humdek/sh2-shp-survey-js',
        repository: { type: 'vcs', url: 'https://github.com/humdek-unibe-ch/sh2-shp-survey-js.git' },
      },
      { pluginId: 'frontend-only', version: '1.0.0', enabled: false, package: null, repository: null },
    ]);
  });

  it('raises a readable error when the backend prints something that is not JSON', async () => {
    const { client } = clientWith('PHP Fatal error: something exploded');
    await expect(client.listPendingOperations()).rejects.toThrow(/non-JSON plugin-state response/);
  });
});

describe('composePluginExecDeps', () => {
  it('builds compose exec args with service, user and env flags, and batches restarts', async () => {
    const runner = new RecordingComposeRunner(() => ({ stdout: 'ok', stderr: '' }));
    const deps = composePluginExecDeps(runner, '/opt/selfhelp/instances/demo1');

    await deps.exec('backend', ['composer', 'require', 'a/b:1.0.0'], {
      env: { COMPOSER_HOME: '/tmp/composer' },
    });
    await deps.exec('worker', ['sh', '-c', 'chgrp www-data /app'], { user: '0' });
    await deps.restart(['backend', 'worker', 'scheduler']);

    expect(runner.calls[0]!.args).toEqual([
      'exec', '-T', '-e', 'COMPOSER_HOME=/tmp/composer', 'backend', 'composer', 'require', 'a/b:1.0.0',
    ]);
    expect(runner.calls[1]!.args).toEqual(['exec', '-T', '--user', '0', 'worker', 'sh', '-c', 'chgrp www-data /app']);
    expect(runner.calls[2]!.args).toEqual(['restart', 'backend', 'worker', 'scheduler']);
  });
});
