#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * SelfHelp Manager CLI entrypoint.
 *
 * `sh-manager` is the only component with Docker access. The Symfony CMS never
 * controls Docker directly; it records instance-scoped update requests that
 * this tool executes.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import type { InstanceMode, ReleaseChannel } from '@shm/schemas';
import { CrossInstanceError } from '@shm/core';
import { discoverEngineRoot } from '@shm/docker';
import { OFFICIAL_REGISTRY_URL } from '@shm/registry';
import { instancePaths, type RemoveMode } from '@shm/instances';
import { DEFAULT_BACKUP_SCHEDULE, type RestoreMode } from '@shm/backup';
import {
  doctor,
  instanceBackup,
  instanceBackupPrune,
  instanceBackupScheduleGet,
  instanceBackupScheduleSet,
  instanceClone,
  instanceGetEnv,
  instanceSetAddress,
  instanceSetEnv,
  instanceGetMailer,
  instanceHealth,
  instanceInstall,
  instanceList,
  instanceRemove,
  instanceRepair,
  instanceRestore,
  instanceSafeMode,
  instanceSetMailer,
  instanceSupportBundle,
  instanceUpdate,
  instanceFrontendUpdate,
  drainInstanceOperations,
  drainInstancePluginOperations,
  serverInit,
  serverPurge,
  serverRunScheduledBackups,
  type BackupScheduleStatus,
} from './actions.js';
import { stripRedundantManagerToken } from './argv.js';
import { ComposeExecBackendOperationsClient, HttpBackendOperationsClient } from './operations-client.js';
import { MANAGER_VERSION, loadTrustedKeys, realDeps } from './env.js';
import { formatHealth, formatPreflight, formatSteps, formatTable } from './output.js';
import { applySelfUpdate, checkSelfUpdate, formatSelfUpdate } from './self-update.js';
import { generateWrapperScript, type WrapperShell } from './wrapper.js';
import type { ManagerRole } from '@shm/auth';
import {
  adminAllowEmailAdd,
  adminBootstrapToken,
  adminCreate,
  adminDisable,
  adminList,
  adminRoleGrant,
  fileOperatorStore,
  parseRoles,
} from './admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = process.env.SELFHELP_ROOT ?? '/opt/selfhelp';
// Default trust anchor = the official SelfHelp production signing key, pinned
// in this repo (packages/schemas/keys/). The dev fixture key under examples/
// has a public seed and must only ever be used when passed explicitly
// (tests/rehearsals via SELFHELP_TRUSTED_KEYS).
const DEFAULT_TRUSTED_KEYS =
  process.env.SELFHELP_TRUSTED_KEYS ?? path.join(here, '..', '..', '..', 'packages', 'schemas', 'keys', 'official-trusted-keys.json');

async function deps(root: string) {
  const trustedKeys = await loadTrustedKeys(DEFAULT_TRUSTED_KEYS);
  // When containerized, learn how the ENGINE sees the state root (Docker
  // Desktop mounts Windows folders under /run/desktop/mnt/host/…) so compose
  // bind sources and backup mounts are emitted from the engine's perspective.
  const mapping = await discoverEngineRoot({ root });
  return realDeps(root, trustedKeys, mapping ? { engineRoot: mapping.engineRoot } : {});
}

function fail(err: unknown): never {
  if (err instanceof CrossInstanceError) {
    console.error(`DENIED (cross-instance): ${err.message}`);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    if (message.includes('ENOENT') && message.includes('selfhelp.server.json')) {
      console.error(
        'This server is not initialized yet. Run first:\n' +
          '  sh-manager server init --server-id <id> --mode production --email <letsencrypt-email>\n' +
          '  (local/testing: sh-manager server init --server-id <id> --mode local)\n' +
          'If you DID initialize and run the manager via Docker, this command was started without the\n' +
          'state folder mounted at /opt/selfhelp - reuse the exact same -v flag for every command,\n' +
          'or generate the wrapper script once and use it instead:\n' +
          '  docker run --rm <image> wrapper --shell powershell > shm.ps1   (bash: --shell bash > shm.sh)',
      );
    }
  }
  process.exit(1);
}

// Forgive a redundant leading `sh-manager` token before any parsing
// (`./shm.ps1 sh-manager instance health x` must behave like the same command
// without the token).
const argv = stripRedundantManagerToken(process.argv);

// Root-only version flag, deliberately NOT registered via program.version():
// commander parses root options anywhere in argv, so a global `--version`
// swallows `instance install/update ... --version <x>` — the CLI printed the
// manager version and exited instead of installing the requested version.
if (argv.length === 3 && ['--version', '-V', 'version'].includes(argv[2] as string)) {
  console.log(MANAGER_VERSION);
  process.exit(0);
}

const program = new Command();
program.name('sh-manager').description('SelfHelp Manager: Docker-only connected installer/updater/server manager.');
program.option('--root <dir>', 'SelfHelp root directory', DEFAULT_ROOT);
program.addHelpText('after', '\nRun `sh-manager --version` to print the manager version.');

program
  .command('self-update')
  .description('Update the manager to the latest release (Docker: pull image + restart the web GUI container; source: git pull + npm ci + build)')
  .option('--check', 'only check and print what would happen; do not apply', false)
  .action(async (opts) => {
    try {
      const check = await checkSelfUpdate({ currentVersion: MANAGER_VERSION });
      console.log(formatSelfUpdate(check));
      if (opts.check) {
        // Scripts can branch on the exit code: 0 = up to date, 2 = update available.
        if (check.updateAvailable) process.exitCode = 2;
        return;
      }
      if (check.error) {
        // Degrade gracefully (offline server): the message above already says
        // the latest release could not be determined.
        return;
      }
      if (!check.updateAvailable) {
        if (check.runtime !== 'docker') return;
        // The manager version is current, but the long-running GUI container
        // may still run an older image (created before the last pull) —
        // reconcile it so "self-update says up to date" implies "the GUI is
        // up to date" too.
        const result = await applySelfUpdate(check);
        if (result.webRestarted) {
          console.log('The web GUI container was on an older image and has been restarted on the current one.');
        } else if (result.webRestartHint) {
          console.log(result.webRestartHint);
        }
        return;
      }
      console.log('\nApplying update...');
      const result = await applySelfUpdate(check);
      for (const step of result.steps) console.log(`  done    ${step}`);
      if (result.webRestarted) {
        console.log(`  done    web GUI container restarted on the new image`);
      } else if (result.webRestartHint) {
        console.log(`  note    ${result.webRestartHint}`);
      }
      console.log(
        check.runtime === 'docker'
          ? `\nManager updated to ${check.latestVersion}. Every next run uses the new image.`
          : `\nManager updated to ${check.latestVersion}. Restart running manager processes to load it.`,
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command('wrapper')
  .description('Print a small `shm` wrapper script that runs the manager image with the right mounts (save it into your state folder)')
  .requiredOption('--shell <shell>', 'powershell|bash')
  .option('--state-root <path>', 'bake an explicit state folder path (default: the folder the saved script lives in)')
  .option('--image <ref>', 'manager image reference (default: the official :latest image)')
  .option('--web-port <port>', 'published GUI port for `shm web`', (v) => parseInt(v, 10), 8765)
  .action((opts) => {
    try {
      // Only the script goes to stdout so `… wrapper --shell powershell > shm.ps1` stays clean.
      process.stdout.write(
        generateWrapperScript({
          shell: opts.shell as WrapperShell,
          root: opts.stateRoot as string | undefined,
          image: opts.image as string | undefined,
          webPort: opts.webPort as number,
        }),
      );
      console.error('Save the script into your state folder, then run it from anywhere (e.g. .\\shm.ps1 server init …).');
    } catch (err) {
      fail(err);
    }
  });

program
  .command('web')
  .description('Start the manager web console (first-run setup + instance management)')
  .option('--host <host>', 'bind host (use 0.0.0.0 when running inside Docker with -p)', '127.0.0.1')
  .option('--port <port>', 'bind port', (v) => parseInt(v, 10), 8765)
  .option('--allow-non-local', 'allow binding to a non-loopback host (auth required; prefer an SSH tunnel)', false)
  // Legacy no-ops: pre-1.3 GUI containers were started with `--mode
  // persistent [--persist]`, and self-update recreates the container with its
  // OLD arguments. Accepting (and ignoring) them keeps that update seamless.
  .addOption(new Option('--mode <mode>').hideHelp())
  .addOption(new Option('--persist').hideHelp())
  .action(async (opts) => {
    try {
      // Lazy import: keeps every other CLI command free of the web app's deps.
      const { startWebUi } = await import('../../web/src/main.js');
      await startWebUi({
        root: program.opts().root as string,
        host: opts.host as string,
        port: opts.port as number,
        allowNonLocal: opts.allowNonLocal as boolean,
        trustedKeysPath: DEFAULT_TRUSTED_KEYS,
      });
      // Keep the process alive; the HTTP server holds the event loop open.
    } catch (err) {
      fail(err);
    }
  });

const server = program.command('server').description('Server-level operations');
server
  .command('init')
  .description('Initialize the server: shared Traefik proxy + inventory')
  .requiredOption('--server-id <id>', 'unique server id')
  .option('--mode <mode>', 'production|local', 'production')
  .option('--email <email>', "Let's Encrypt contact email (production)")
  .option('--import', 'acknowledge import/repair of an existing or partial install', false)
  .action(async (opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await serverInit(d, { serverId: opts.serverId, mode: opts.mode as InstanceMode, letsencryptEmail: opts.email, allowImport: opts.import as boolean });
      console.log(`Proxy compose: ${res.proxyComposePath}`);
      console.log(`Inventory:     ${res.inventoryPath}`);
    } catch (err) {
      fail(err);
    }
  });

server
  .command('status')
  .description('Show whether this server is initialized and which instances it manages')
  .action(async () => {
    try {
      const root = program.opts().root as string;
      const d = await deps(root);
      const rows = await instanceList(d).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('selfhelp.server.json')) return null;
        throw err;
      });
      if (rows === null) {
        console.log(`Server NOT initialized (no inventory under ${root}).`);
        console.log('Run: sh-manager server init --server-id <id> --mode local|production');
        return;
      }
      console.log(`Server initialized. Root: ${root}. Manager: ${MANAGER_VERSION}. Instances: ${rows.length}.`);
      if (rows.length > 0) {
        console.log(formatTable(['INSTANCE', 'DOMAIN', 'STATUS', 'PROJECT'], rows.map((r) => [r.instanceId, r.domain, r.status, r.composeProject])));
      }
    } catch (err) {
      fail(err);
    }
  });

server
  .command('purge')
  .description('DANGER: remove EVERYTHING this manager created — all instances (containers, volumes, data), the shared proxy, and server state. Backups are kept unless --delete-backups.')
  .option('--confirm <text>', 'required: "purge selfhelp"')
  .option('--delete-backups', 'also delete every instance backup', false)
  .action(async (opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await serverPurge(d, {
        confirm: opts.confirm as string | undefined,
        deleteBackups: opts.deleteBackups as boolean,
      });
      if (!res.ok && res.instancesRemoved.length === 0 && !res.proxyRemoved) {
        console.error(formatSteps('Purge blocked:', res.errors));
        process.exit(1);
      }
      for (const id of res.instancesRemoved) console.log(`  removed instance ${id}`);
      if (res.proxyRemoved) console.log('  removed shared proxy (Traefik)');
      if (res.networkRemoved) console.log('  removed proxy network');
      for (const p of res.removedPaths) console.log(`  removed ${p}`);
      for (const p of res.keptPaths) console.log(`  kept    ${p}`);
      for (const e of res.errors) console.log(`  warning ${e}`);
      console.log(res.ok ? '\nServer purged. Run `sh-manager server init` to start fresh.' : '\nServer purged with warnings (see above).');
      if (!res.ok) process.exitCode = 1;
    } catch (err) {
      fail(err);
    }
  });

server
  .command('run-scheduled-backups')
  .description('One-shot: take every due scheduled backup + prune by retention (for cron / systemd timers; the web GUI runs this automatically)')
  .action(async () => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await serverRunScheduledBackups(d, { log: (line) => console.log(line) });
      if (res.entries.length === 0) {
        console.log('No instance has an enabled backup schedule with a due run.');
        return;
      }
      console.log(
        formatTable(
          ['INSTANCE', 'ACTION', 'BACKUP', 'PRUNED', 'DETAIL'],
          res.entries.map((e) => [e.instanceId, e.action, e.backupId ?? '-', e.prunedCount !== undefined ? String(e.prunedCount) : '-', e.detail ?? '']),
        ),
      );
      if (res.entries.some((e) => e.action === 'failed')) process.exitCode = 1;
    } catch (err) {
      fail(err);
    }
  });

const instance = program.command('instance').description('Instance-level operations');

instance
  .command('list')
  .description('List installed instances')
  .action(async () => {
    try {
      const rows = await instanceList(await deps(program.opts().root as string));
      console.log(formatTable(['INSTANCE', 'DOMAIN', 'STATUS', 'PROJECT'], rows.map((r) => [r.instanceId, r.domain, r.status, r.composeProject])));
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('install')
  .description('Install a new instance from the official registry')
  .requiredOption('--id <id>', 'instance id (lowercase)')
  .option('--registry <url>', 'registry base url', OFFICIAL_REGISTRY_URL)
  .option('--name <name>', 'display name')
  .option('--mode <mode>', 'production|local', 'production')
  .option('--domain <domain>', 'public domain (production)')
  .option('--port <port>', 'localhost port (local)', (v) => parseInt(v, 10))
  .option('--strict-dns', 'production: block (not just warn) when DNS does not resolve to this server', false)
  .option('--channel <channel>', 'stable|beta|nightly', 'stable')
  .option('--version <version>', "core version or 'latest'", 'latest')
  .option('--up', 'bring the stack up after install', false)
  .option('--provision', 'after up: wait for DB, migrate, create admin, install plugins, warm caches, health-check', false)
  .option('--admin-email <email>', 'create the first CMS admin during provisioning')
  .option('--admin-name <name>', 'admin display name', 'Admin')
  .option('--admin-password <password>', 'admin password (a strong one is generated + shown once if omitted)')
  .option('--plugin-manifest <path...>', 'plugin.json path(s) inside the backend container to install during provisioning')
  .option('--mailer-dsn <dsn>', 'outbound SMTP DSN, e.g. smtp://user:pass@mail.example.org:587 (default: bundled Mailpit)')
  .action(async (opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceInstall(d, {
        instanceId: opts.id,
        displayName: opts.name ?? opts.id,
        mode: opts.mode as InstanceMode,
        domain: opts.domain,
        localPort: opts.port,
        strictDns: opts.strictDns as boolean,
        registryUrl: opts.registry,
        channel: opts.channel as ReleaseChannel,
        version: opts.version,
        bringUp: opts.up,
        provision: opts.provision,
        adminEmail: opts.adminEmail,
        adminName: opts.adminName,
        adminPassword: opts.adminPassword,
        pluginManifests: opts.pluginManifest as string[] | undefined,
        mailerDsn: opts.mailerDsn as string | undefined,
      });
      console.log(`Installed ${opts.id} (SelfHelp ${res.version}) at ${res.instanceDir}${res.broughtUp ? ' [started]' : ''}`);
      for (const w of res.domainWarnings) console.log(`  warning: ${w}`);
      if (res.provision) {
        console.log(`\nProvisioning: ${res.provision.ok ? 'OK' : 'FAILED'}`);
        for (const s of res.provision.steps) {
          console.log(`  ${s.status.padEnd(7)} ${s.name}${s.detail ? ` (${s.detail})` : ''}`);
        }
        if (res.adminPassword) {
          console.log(`\nGenerated admin password (shown once, store it now): ${res.adminPassword}`);
          if (res.adminPasswordFile) {
            console.log(`Also saved to ${res.adminPasswordFile} (owner-only file) - delete it after your first sign-in.`);
          }
        }
        if (!res.provision.ok) process.exitCode = 1;
      }
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('health <id>')
  .description('Check instance health')
  .action(async (id: string) => {
    try {
      console.log(formatHealth(await instanceHealth(await deps(program.opts().root as string), id)));
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('update <id>')
  .description('Plan (dry-run) or execute an instance update')
  .option('--dry-run', 'only show the plan + preflight', false)
  .option('--channel <channel>', 'stable|beta|nightly')
  .option('--version <version>', "target core version or 'latest'")
  .option('--accept-migration-risk', 'accept destructive migration risk', false)
  .option('--approve-mysql-major', 'approve a one-way MySQL major-version upgrade required by the target', false)
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceUpdate(d, id, {
        dryRun: opts.dryRun,
        channel: opts.channel as ReleaseChannel | undefined,
        target: opts.version,
        acceptMigrationRisk: opts.acceptMigrationRisk,
        approveMysqlMajor: opts.approveMysqlMajor,
      });
      if (res.plan.preflight) console.log(formatPreflight(res.plan.preflight));
      else console.log(`Update status: ${res.plan.status} - ${res.plan.reasons.join('; ')}`);
      if (res.executed && res.report) {
        console.log(`\nExecution: ${res.report.ok ? 'OK' : res.report.rolledBack ? 'ROLLED BACK' : 'FAILED'}`);
        for (const s of res.report.steps) console.log(`  ${s.status.padEnd(7)} ${s.name}${s.detail ? ` (${s.detail})` : ''}`);
      }

      // Smooth path: the core is up to date, but the frontend ships
      // independently, so a newer compatible frontend may still be available.
      // Surface it (and apply it unless this was a dry run / a specific core
      // version was requested) so `instance update` never silently leaves a
      // stale frontend behind.
      if (res.plan.status === 'up_to_date' && !opts.version) {
        const fe = await instanceFrontendUpdate(d, id, { dryRun: opts.dryRun, channel: opts.channel as ReleaseChannel | undefined });
        if (fe.plan.status === 'ok' && fe.plan.frontend) {
          console.log(
            `\nFrontend update ${opts.dryRun ? 'available' : 'applied'}: ${fe.plan.currentFrontendVersion} -> ${fe.plan.targetFrontendVersion}`,
          );
          if (fe.executed && fe.report) {
            console.log(`Execution: ${fe.report.ok ? 'OK' : fe.report.rolledBack ? 'ROLLED BACK' : 'FAILED'}`);
            for (const s of fe.report.steps) console.log(`  ${s.status.padEnd(7)} ${s.name}${s.detail ? ` (${s.detail})` : ''}`);
          }
        }
      }
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('update-frontend <id>')
  .description('Plan (dry-run) or execute a frontend-only update (leaves the core stack + all data untouched)')
  .option('--dry-run', 'only show the plan', false)
  .option('--channel <channel>', 'stable|beta|nightly')
  .option('--version <version>', "target frontend version or 'latest'")
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceFrontendUpdate(d, id, {
        dryRun: opts.dryRun,
        channel: opts.channel as ReleaseChannel | undefined,
        target: opts.version,
      });
      if (res.plan.status === 'ok' && res.plan.frontend) {
        console.log(`Frontend update: ${res.plan.currentFrontendVersion} -> ${res.plan.targetFrontendVersion}`);
        for (const step of res.plan.steps) console.log(`  - ${step}`);
      } else {
        console.log(`Frontend update status: ${res.plan.status} - ${res.plan.reasons.join('; ') || 'no newer frontend available'}`);
      }
      if (res.executed && res.report) {
        console.log(`\nExecution: ${res.report.ok ? 'OK' : res.report.rolledBack ? 'ROLLED BACK' : 'FAILED'}`);
        for (const s of res.report.steps) console.log(`  ${s.status.padEnd(7)} ${s.name}${s.detail ? ` (${s.detail})` : ''}`);
      }
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('process-operations <id>')
  .description('Drain all pending CMS-requested update operations for an instance (--watch runs it as a supervised loop)')
  .option('--backend-url <url>', "internal base URL of this instance's backend (default: exec into the backend container — no published port needed)")
  .option('--token <token>', 'per-instance manager token, only with --backend-url (default: env SELFHELP_MANAGER_TOKEN)')
  .option('--watch', 'keep running, draining pending operations every --interval seconds (for systemd/supervised use)', false)
  .option('--interval <seconds>', 'poll interval in --watch mode (default 15)', (v) => parseInt(v, 10), 15)
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      let client;
      if (opts.backendUrl) {
        const token = (opts.token as string | undefined) ?? process.env.SELFHELP_MANAGER_TOKEN;
        if (!token) {
          throw new Error('A per-instance manager token is required with --backend-url (--token or SELFHELP_MANAGER_TOKEN).');
        }
        client = new HttpBackendOperationsClient({
          backendBaseUrl: opts.backendUrl as string,
          managerToken: token,
          instanceId: id,
        });
      } else {
        // Default transport: exec the HTTP call inside the backend container.
        // The token stays in the container's own env; nothing is published.
        client = new ComposeExecBackendOperationsClient({
          runner: d.runner,
          instanceDir: instancePaths(id, program.opts().root as string).dir,
          instanceId: id,
        });
      }
      const drainOnce = async () => {
        const outcomes = await drainInstanceOperations(d, id, client);
        for (const outcome of outcomes) {
          if (outcome.result === 'rejected') {
            console.log(`Operation ${outcome.operationId} rejected (${outcome.status}): ${outcome.reason}`);
          } else if (outcome.result === 'completed') {
            console.log(`Operation ${outcome.operationId} finished: ${outcome.status}.`);
          }
        }
        // Managed-mode plugin operations parked by the CMS (install/update/
        // uninstall): the manager runs the composer step + finalize.
        const pluginReport = await drainInstancePluginOperations(d, id, { log: (l) => console.log(l) });
        for (const outcome of pluginReport.outcomes) {
          console.log(
            outcome.status === 'done'
              ? `Plugin ${outcome.type} ${outcome.pluginId} (operation #${outcome.operationId}) finished.`
              : `Plugin ${outcome.type} ${outcome.pluginId} (operation #${outcome.operationId}) failed: ${outcome.detail ?? 'unknown error'}`,
          );
        }
        if (outcomes.length === 0 && pluginReport.outcomes.length === 0) {
          console.log(`No pending operations for ${id}.`);
        }
      };

      if (!opts.watch) {
        await drainOnce();
        return;
      }

      const intervalMs = Math.max(1, Number(opts.interval) || 15) * 1000;
      console.log(`Watching ${id} for pending operations every ${intervalMs / 1000}s. Ctrl-C to stop.`);
      let stopping = false;
      const stop = () => {
        stopping = true;
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      while (!stopping) {
        try {
          await drainOnce();
        } catch (err) {
          console.error(`process-operations tick failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (stopping) break;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      console.log('Stopped.');
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('backup <id>')
  .description('Create a checksummed backup of the instance')
  .option('--seq <n>', 'backup sequence number for the day', (v) => parseInt(v, 10))
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceBackup(d, id, { seq: opts.seq });
      console.log(`Backup ${res.backupId} -> ${res.backupDir}`);
      console.log(`Areas: ${res.manifest.includedAreas.join(', ')}  Files: ${res.manifest.files.length}`);
    } catch (err) {
      fail(err);
    }
  });

function printScheduleStatus(status: BackupScheduleStatus): void {
  if (!status.policy) {
    console.log(`No backup schedule configured for ${status.instanceId}.`);
    console.log('Enable one with: sh-manager instance backup-schedule <id> --enable [--time HH:MM]');
    return;
  }
  const p = status.policy;
  const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  console.log(`Backup schedule for ${status.instanceId}: ${p.enabled ? 'ENABLED' : 'disabled'}`);
  console.log(`  Daily at ${p.time} (server local time)`);
  console.log(
    `  Retention: ${p.retention.daily} dailies, ${p.retention.weekly} weeklies (Mon), ` +
      `${p.retention.monthly} monthlies (1st), max age ${p.retention.maxAgeDays} days`,
  );
  console.log(`  Last run:  ${status.lastRunAt ?? 'never'}${status.lastResult ? ` (${status.lastResult})` : ''}`);
  if (status.lastDetail) console.log(`             ${status.lastDetail}`);
  console.log(`  Next run:  ${status.nextRunAt ?? '-'}`);
  console.log(`  Backups:   ${status.backups.count} on disk, ${mib(status.backups.totalBytes)} total`);
  console.log(
    `  Projected steady state: ~${mib(status.footprint.steadyStateBytes)} ` +
      `(${status.footprint.slots} retention slots x ${mib(status.footprint.averageBackupBytes)} average)`,
  );
}

instance
  .command('backup-schedule <id>')
  .description('Show or change the nightly backup schedule + GFS retention of an instance')
  .option('--enable', 'enable scheduled backups')
  .option('--disable', 'disable scheduled backups')
  .option('--time <HH:MM>', 'daily run time, server local time (default 02:00)')
  .option('--keep-daily <n>', 'retained daily backups', (v) => parseInt(v, 10))
  .option('--keep-weekly <n>', 'retained weekly (Monday) backups', (v) => parseInt(v, 10))
  .option('--keep-monthly <n>', 'retained monthly (1st of month) backups', (v) => parseInt(v, 10))
  .option('--max-age-days <n>', 'hard cap: prunable backups older than this are deleted', (v) => parseInt(v, 10))
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const mutating =
        opts.enable || opts.disable || opts.time !== undefined || opts.keepDaily !== undefined ||
        opts.keepWeekly !== undefined || opts.keepMonthly !== undefined || opts.maxAgeDays !== undefined;
      if (opts.enable && opts.disable) {
        console.error('Error: --enable and --disable are mutually exclusive.');
        process.exit(1);
      }
      if (!mutating) {
        printScheduleStatus(await instanceBackupScheduleGet(d, id));
        return;
      }
      const current = (await instanceBackupScheduleGet(d, id)).policy ?? DEFAULT_BACKUP_SCHEDULE;
      const policy = {
        enabled: opts.enable ? true : opts.disable ? false : current.enabled,
        time: (opts.time as string | undefined) ?? current.time,
        retention: {
          daily: (opts.keepDaily as number | undefined) ?? current.retention.daily,
          weekly: (opts.keepWeekly as number | undefined) ?? current.retention.weekly,
          monthly: (opts.keepMonthly as number | undefined) ?? current.retention.monthly,
          maxAgeDays: (opts.maxAgeDays as number | undefined) ?? current.retention.maxAgeDays,
        },
      };
      printScheduleStatus(await instanceBackupScheduleSet(d, id, policy));
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('backup-prune <id>')
  .description('Apply the GFS retention policy to the instance backups (--dry-run shows the plan only)')
  .option('--dry-run', 'show what would be kept/deleted without deleting anything', false)
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceBackupPrune(d, id, { dryRun: opts.dryRun as boolean });
      console.log(
        formatTable(
          ['BACKUP', 'ORIGIN', 'DECISION', 'REASONS'],
          [...res.plan.keep, ...res.plan.prune].map((dec) => [dec.backupId, dec.origin, dec.action, dec.reasons.join(', ')]),
        ),
      );
      for (const s of res.skipped) console.log(`  skipped ${s.name}: ${s.reason}`);
      console.log(
        res.dryRun
          ? `Dry run: ${res.plan.prune.length} backup(s) would be deleted, nothing was touched.`
          : `Deleted ${res.deleted.length} backup(s); kept ${res.plan.keep.length}.`,
      );
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('restore <id> <backupId>')
  .description('Validate a backup and show the restore plan; --apply executes the restore (DB + volumes)')
  .option('--mode <mode>', 'same_instance|restore_as_clone', 'same_instance')
  .option('--new-domain <domain>', 'new domain (restore_as_clone)')
  .option('--disaster-recovery-import', 'allow importing a backup from a different instance', false)
  .option('--apply', 'execute the restore: stop, restore DB + volumes, migrate if needed, health-check', false)
  .action(async (id: string, backupId: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceRestore(d, id, backupId, {
        mode: opts.mode as RestoreMode,
        newDomain: opts.newDomain,
        disasterRecoveryImport: opts.disasterRecoveryImport,
        apply: opts.apply,
      });
      if (!res.validation.ok || !res.plan) {
        console.error(formatSteps(`Restore blocked for ${id} <- ${backupId}:`, res.validation.errors));
        process.exit(1);
      }
      console.log(formatSteps(`Restore plan for ${id} <- ${backupId} (${res.plan.mode}):`, res.plan.steps));
      if (opts.apply && res.executed) {
        console.log(
          res.secretsRegenerated
            ? `Fresh secrets written: ${res.secretsWritten?.length ?? 0} files (source secrets never reused).`
            : 'Same-instance restore: existing secrets preserved in place.',
        );
        if (res.migrated) console.log('Ran forward migrations (restored DB head differed from running code).');
        if (res.health) console.log(formatHealth(res.health));
      }
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('clone <source> <target>')
  .description('Show the clone plan for creating <target> from <source>; --apply builds + populates the clone')
  .option('--domain <domain>', 'new public domain (cloning a production instance)')
  .option('--target-local-port <port>', 'new published localhost port (cloning a local instance)', (v) => Number(v))
  .option('--no-preserve-versions', 'resolve latest compatible versions instead of pinning the source lock')
  .option('--no-uploads', 'do not copy uploads')
  .option('--no-plugins', 'do not copy plugin artifacts')
  .option('--apply', 'execute the clone: fresh secrets, copy DB + volumes, bring up, health-check', false)
  .action(async (source: string, target: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceClone(d, source, target, {
        ...(opts.domain ? { targetDomain: opts.domain as string } : {}),
        ...(opts.targetLocalPort !== undefined ? { targetLocalPort: opts.targetLocalPort as number } : {}),
        preserveVersions: opts.preserveVersions,
        copyUploads: opts.uploads,
        copyPluginArtifacts: opts.plugins,
        apply: opts.apply,
      });
      console.log(formatSteps(`Clone plan ${source} -> ${target} (${res.plan.targetDomain}):`, res.plan.steps));
      if (opts.apply && res.executed) {
        console.log(`Fresh secrets written for ${target}: ${res.secretsWritten?.length ?? 0} files (source never copied).`);
        if (res.health) console.log(formatHealth(res.health));
      }
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('set-address <id>')
  .description('Change where an instance is reachable (production: --domain, local: --port), regenerate its config and restart it')
  .option('--domain <domain>', 'new public domain (production instances)')
  .option('--port <port>', 'new published localhost port (local instances)', (v) => parseInt(v, 10))
  .option('--no-restart', 'write the new config only; apply it later with docker compose up -d')
  .option('--strict-dns', 'production: block (not just warn) when DNS does not resolve to this server', false)
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceSetAddress(d, id, {
        ...(opts.domain ? { domain: opts.domain as string } : {}),
        ...(opts.port !== undefined ? { localPort: opts.port as number } : {}),
        restart: opts.restart as boolean,
        strictDns: opts.strictDns as boolean,
      });
      console.log(
        res.changed
          ? `Address changed: ${res.previousDomain} -> ${res.domain}`
          : `Configuration re-applied for ${res.domain} (address unchanged).`,
      );
      for (const w of res.warnings) console.log(`  warning: ${w}`);
      console.log(res.restarted ? `Instance restarted; reachable at ${res.publicUrl}` : 'Config written. Restart pending (run docker compose up -d in the instance directory).');
      if (res.health) console.log(formatHealth(res.health));
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('mailer <id>')
  .description('Show or change the instance outbound-mail (SMTP) configuration')
  .option('--set <dsn>', 'set the SMTP DSN, e.g. smtp://user:pass@mail.example.org:587')
  .option('--clear', 'remove the override and fall back to the bundled Mailpit/default', false)
  .option('--no-restart', 'write the config only; apply later with docker compose up -d')
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      if (!opts.set && !opts.clear) {
        const status = await instanceGetMailer(d, id);
        console.log(
          status.configured
            ? `Mailer DSN: ${status.redactedDsn} (custom, credentials redacted)`
            : 'Mailer DSN: default (bundled Mailpit on local instances; configure one with --set <dsn>)',
        );
        return;
      }
      const res = await instanceSetMailer(d, id, {
        ...(opts.set ? { dsn: opts.set as string } : {}),
        clear: opts.clear as boolean,
        restart: opts.restart as boolean,
      });
      console.log(res.configured ? `Mailer DSN set to ${res.redactedDsn}.` : 'Mailer override cleared (back to default).');
      console.log(res.restarted ? 'Instance restarted with the new mail configuration.' : 'Config written. Restart pending (docker compose up -d).');
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('env <id>')
  .description('Show or edit an instance\'s non-secret environment (.env). Manager-owned and secret keys are protected.')
  .option(
    '--set <KEY=VALUE>',
    'set/override a variable (repeatable)',
    (kv: string, prev: string[]) => prev.concat(kv),
    [] as string[],
  )
  .option('--unset <KEY>', 'remove an operator override (repeatable)', (k: string, prev: string[]) => prev.concat(k), [] as string[])
  .option('--no-restart', 'write the config only; apply later with docker compose up -d')
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const sets = opts.set as string[];
      const unsets = opts.unset as string[];

      // No mutation requested -> just print the effective environment.
      if (sets.length === 0 && unsets.length === 0) {
        const cfg = await instanceGetEnv(d, id);
        for (const e of cfg.entries) {
          const tags = [e.managed ? 'managed' : e.overridden ? 'override' : e.custom ? 'custom' : 'default'];
          console.log(`${e.key}=${e.value}  [${tags.join(',')}]`);
        }
        return;
      }

      // Incremental edit: start from the current overrides, apply set/unset.
      const cfg = await instanceGetEnv(d, id);
      const overrides: Record<string, string> = {};
      for (const e of cfg.entries) if (e.overridden) overrides[e.key] = e.value;
      for (const kv of sets) {
        const eq = kv.indexOf('=');
        if (eq <= 0) throw new Error(`--set expects KEY=VALUE, got "${kv}".`);
        overrides[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
      }
      for (const k of unsets) delete overrides[k.trim()];

      const res = await instanceSetEnv(d, id, { overrides, restart: opts.restart as boolean });
      console.log(`Applied ${res.applied} environment override${res.applied === 1 ? '' : 's'}.`);
      console.log(res.restarted ? 'Instance restarted with the new environment.' : 'Config written. Restart pending (docker compose up -d).');
      if (res.health) console.log(formatHealth(res.health));
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('remove <id>')
  .description('Disable, remove-keep-data, or fully delete an instance')
  .requiredOption('--mode <mode>', 'disable|remove_containers_keep_data|full_delete')
  .option('--delete-volumes', 'full_delete: also delete persistent volumes', false)
  .option('--delete-backups', 'full_delete: also delete backups', false)
  .option('--confirm <text>', 'full_delete requires: "delete <id>"')
  .action(async (id: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceRemove(d, id, {
        mode: opts.mode as RemoveMode,
        deleteVolumes: opts.deleteVolumes,
        deleteBackups: opts.deleteBackups,
        confirm: opts.confirm,
      });
      if (!res.executed) {
        console.error(formatSteps(`Remove blocked for ${id}:`, res.errors));
        process.exit(1);
      }
      console.log(formatSteps(`Removed ${id} (${res.mode}):`, res.steps));
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('support-bundle <id>')
  .description('Collect a redacted support bundle')
  .action(async (id: string) => {
    try {
      const res = await instanceSupportBundle(await deps(program.opts().root as string), id);
      console.log(`Support bundle: ${res.dir}`);
      console.log(`Files: ${res.files.join(', ')}`);
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('repair <id>')
  .description('Reconstruct a missing/corrupted instance manifest (newest backup snapshot, else inventory + lock + compose) and re-register the instance')
  .action(async (id: string) => {
    try {
      const res = await instanceRepair(await deps(program.opts().root as string), id);
      console.log(res.repaired ? `Repaired ${id} (source: ${res.source}).` : `Nothing to repair for ${id}.`);
      for (const note of res.notes) console.log(`  ${note}`);
    } catch (err) {
      fail(err);
    }
  });

const safeMode = instance
  .command('safe-mode')
  .description('Toggle system safe mode (boot backend with core bundles only — no plugins) for an instance');
safeMode
  .command('enable <id>')
  .description('Enable system safe mode (no plugins load on next boot)')
  .action(async (id: string) => {
    try {
      await instanceSafeMode(await deps(program.opts().root as string), id, true);
      console.log(`Safe mode enabled for ${id}.`);
    } catch (err) {
      fail(err);
    }
  });
safeMode
  .command('disable <id>')
  .description('Disable system safe mode (plugins load again)')
  .action(async (id: string) => {
    try {
      await instanceSafeMode(await deps(program.opts().root as string), id, false);
      console.log(`Safe mode disabled for ${id}.`);
    } catch (err) {
      fail(err);
    }
  });

const admin = program.command('admin').description('Manage manager operators (local auth + OIDC allowlist)');

admin
  .command('create')
  .description('Create a local operator (web UI sign-in account)')
  .requiredOption('--email <email>', 'operator email')
  .requiredOption('--roles <roles>', 'comma-separated roles: server_owner,instance_operator,read_only')
  .option('--name <name>', 'display name')
  .option('--password <password>', 'operator password (or env SELFHELP_MANAGER_ADMIN_PASSWORD; a strong one is generated + shown once if omitted)')
  .action(async (opts) => {
    try {
      const provided = (opts.password as string | undefined) ?? process.env.SELFHELP_MANAGER_ADMIN_PASSWORD;
      // Same convention as `instance install --admin-password`: omitted =
      // generate a strong one and print it exactly once (never stored in clear).
      const generated = provided === undefined || provided === '' ? randomBytes(18).toString('base64url') : undefined;
      const password = generated ?? (provided as string);
      const store = fileOperatorStore(program.opts().root as string);
      const op = await adminCreate(store, {
        email: opts.email,
        displayName: (opts.name as string | undefined) ?? opts.email,
        password,
        roles: parseRoles(opts.roles as string),
      });
      console.log(`Created operator ${op.email} [${op.roles.join(', ')}].`);
      if (generated) {
        console.log(`Generated password (shown once, store it now): ${generated}`);
      }
      console.log('Sign in at the manager web UI (sh-manager web) with this email + password.');
    } catch (err) {
      fail(err);
    }
  });

admin
  .command('disable <email>')
  .description('Disable an operator (keeps the record; blocks login)')
  .action(async (email: string) => {
    try {
      await adminDisable(fileOperatorStore(program.opts().root as string), email);
      console.log(`Disabled operator ${email}.`);
    } catch (err) {
      fail(err);
    }
  });

const adminRole = admin.command('role').description('Operator role management');
adminRole
  .command('grant <email> <role>')
  .description('Grant a role to an operator')
  .action(async (email: string, role: string) => {
    try {
      await adminRoleGrant(fileOperatorStore(program.opts().root as string), email, role as ManagerRole);
      console.log(`Granted ${role} to ${email}.`);
    } catch (err) {
      fail(err);
    }
  });

const adminAllowEmail = admin.command('allow-email').description('OIDC email allowlist management');
adminAllowEmail
  .command('add <email>')
  .description('Allow an email to authenticate via OIDC')
  .action(async (email: string) => {
    try {
      await adminAllowEmailAdd(fileOperatorStore(program.opts().root as string), email);
      console.log(`Allowed OIDC email ${email}.`);
    } catch (err) {
      fail(err);
    }
  });

admin
  .command('list')
  .description('List operators (password digests never shown)')
  .action(async () => {
    try {
      const ops = await adminList(fileOperatorStore(program.opts().root as string));
      console.log(
        formatTable(
          ['EMAIL', 'NAME', 'ROLES', 'SOURCE', 'STATUS'],
          ops.map((o) => [o.email, o.displayName, o.roles.join('/'), o.source, o.disabled ? 'disabled' : 'active']),
        ),
      );
    } catch (err) {
      fail(err);
    }
  });

admin
  .command('bootstrap-token')
  .description('Issue a one-time bootstrap token to unlock first-run operator creation')
  .option('--ttl <seconds>', 'token lifetime in seconds', (v) => parseInt(v, 10), 3600)
  .action(async (opts) => {
    try {
      const token = await adminBootstrapToken(fileOperatorStore(program.opts().root as string), opts.ttl as number);
      console.log(`Bootstrap token (valid ${opts.ttl}s, shown once):\n${token}`);
    } catch (err) {
      fail(err);
    }
  });

const serverDoctor = program.command('doctor').description('Run host resource preflight checks');
serverDoctor.action(async () => {
  try {
    const d = await deps(program.opts().root as string);
    console.log(formatPreflight(await doctor(d, [80, 443])));
  } catch (err) {
    fail(err);
  }
});

program.parseAsync(argv).catch(fail);
