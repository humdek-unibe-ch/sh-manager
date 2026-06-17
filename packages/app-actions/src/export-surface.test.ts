// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Characterization test for the shared application-action surface.
 *
 * `apps/cli/src/actions.ts` (and its sibling env/self-update/clients) is consumed
 * by name from the CLI (`bin.ts`), the web BFF (`apps/web/src/instances.ts`,
 * `main.ts`) and the e2e harness. The maintainability refactor splits this layer
 * into submodules and later relocates it into `@shm/app-actions`; this test pins
 * the exact set of runtime (value) exports so any drop/rename during the move
 * fails loudly instead of silently breaking a consumer. Type-only exports are
 * covered by `tsc` (consumers would not typecheck without them).
 */
import { describe, expect, it } from 'vitest';
import * as actions from './actions.js';
import * as env from './env.js';
import * as selfUpdate from './self-update.js';
import * as operationsClient from './operations-client.js';
import * as pluginStateClient from './plugin-state-client.js';

type Surface = Record<string, 'function' | 'string' | 'array'>;

function expectSurface(mod: Record<string, unknown>, surface: Surface): void {
  for (const [name, kind] of Object.entries(surface)) {
    const value = mod[name];
    if (kind === 'array') {
      expect(Array.isArray(value), `${name} must be an exported array`).toBe(true);
    } else {
      expect(typeof value, `${name} must be an exported ${kind}`).toBe(kind);
    }
  }
}

describe('shared application-action export surface', () => {
  it('actions.ts exports every action consumed across boundaries', () => {
    expectSurface(actions as unknown as Record<string, unknown>, {
      // server / bootstrap
      serverInit: 'function',
      ensureProxyRunning: 'function',
      serverStartProxy: 'function',
      serverPurge: 'function',
      serverProxyLogs: 'function',
      serverRunScheduledBackups: 'function',
      // install + read
      instanceInstall: 'function',
      instanceList: 'function',
      instanceHealth: 'function',
      doctor: 'function',
      ADMIN_PASSWORD_FILENAME: 'string',
      // update + operations
      instanceUpdate: 'function',
      instanceFrontendUpdate: 'function',
      buildOperationExecutor: 'function',
      processInstanceOperations: 'function',
      drainInstanceOperations: 'function',
      describePluginOperation: 'function',
      hasPendingPluginOperations: 'function',
      drainInstancePluginOperations: 'function',
      instanceListInstalledPlugins: 'function',
      // backup + restore/clone
      instanceBackup: 'function',
      listInstanceBackups: 'function',
      instanceBackupScheduleGet: 'function',
      instanceBackupScheduleSet: 'function',
      instanceBackupPrune: 'function',
      instanceHasDueScheduledBackup: 'function',
      instanceRunScheduledBackup: 'function',
      instanceRestore: 'function',
      instanceClone: 'function',
      // lifecycle
      instanceSetAddress: 'function',
      instanceSetName: 'function',
      instanceRemove: 'function',
      instanceEnable: 'function',
      instanceGetMailer: 'function',
      instanceSetMailer: 'function',
      instanceGetEnv: 'function',
      instanceSetEnv: 'function',
      // diagnostics
      instanceSupportBundle: 'function',
      instanceLogs: 'function',
      LOG_SERVICES: 'array',
      instanceRepair: 'function',
      instanceSafeMode: 'function',
      instancePluginRecover: 'function',
      // orphan discovery + cleanup (create-wizard "leftover data" flow)
      scanInstanceOrphans: 'function',
      cleanupInstanceOrphans: 'function',
    });
  });

  it('env.ts exports the real ActionDeps wiring', () => {
    expectSurface(env as unknown as Record<string, unknown>, {
      loadTrustedKeys: 'function',
      localhostProbeHost: 'function',
      rewriteLocalhostUrl: 'function',
      realDeps: 'function',
      MANAGER_VERSION: 'string',
    });
  });

  it('self-update.ts exports the check/apply surface', () => {
    expectSurface(selfUpdate as unknown as Record<string, unknown>, {
      MANAGER_RELEASES_LATEST_URL: 'string',
      MANAGER_IMAGE: 'string',
      MANAGER_REPO_URL: 'string',
      WEB_CONTAINER_NAME: 'string',
      detectManagerRuntime: 'function',
      selfUpdateInstructions: 'function',
      checkSelfUpdate: 'function',
      formatSelfUpdate: 'function',
      realExec: 'function',
      nextWebImage: 'function',
      webRunArgs: 'function',
      applySelfUpdate: 'function',
    });
  });

  it('operations-client.ts exports both backend operation clients', () => {
    expectSurface(operationsClient as unknown as Record<string, unknown>, {
      HttpBackendOperationsClient: 'function',
      ComposeExecBackendOperationsClient: 'function',
    });
  });

  it('plugin-state-client.ts exports the plugin-state surface', () => {
    expectSurface(pluginStateClient as unknown as Record<string, unknown>, {
      parseRunbookCommand: 'function',
      ComposeExecPluginStateClient: 'function',
      composePluginExecDeps: 'function',
    });
  });
});
