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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { InstanceMode, ReleaseChannel } from '@shm/schemas';
import { CrossInstanceError } from '@shm/core';
import type { RemoveMode } from '@shm/instances';
import type { RestoreMode } from '@shm/backup';
import {
  doctor,
  instanceBackup,
  instanceClone,
  instanceHealth,
  instanceInstall,
  instanceList,
  instanceRemove,
  instanceRestore,
  instanceSafeMode,
  instanceSupportBundle,
  instanceUpdate,
  drainInstanceOperations,
  serverInit,
} from './actions.js';
import { HttpBackendOperationsClient } from './operations-client.js';
import { loadTrustedKeys, realDeps } from './env.js';
import { formatHealth, formatPreflight, formatSteps, formatTable } from './output.js';
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
const DEFAULT_TRUSTED_KEYS =
  process.env.SELFHELP_TRUSTED_KEYS ?? path.join(here, '..', '..', '..', 'packages', 'schemas', 'examples', 'trusted-keys.json');

async function deps(root: string) {
  const trustedKeys = await loadTrustedKeys(DEFAULT_TRUSTED_KEYS);
  return realDeps(root, trustedKeys);
}

function fail(err: unknown): never {
  if (err instanceof CrossInstanceError) {
    console.error(`DENIED (cross-instance): ${err.message}`);
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

const program = new Command();
program.name('sh-manager').description('SelfHelp Manager: Docker-only connected installer/updater/server manager.').version('0.1.1');
program.option('--root <dir>', 'SelfHelp root directory', DEFAULT_ROOT);

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
  .requiredOption('--registry <url>', 'registry base url')
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
    } catch (err) {
      fail(err);
    }
  });

instance
  .command('process-operations <id>')
  .description('Drain all pending CMS-requested update operations for an instance (--watch runs it as a supervised loop)')
  .requiredOption('--backend-url <url>', "internal base URL of this instance's backend")
  .option('--token <token>', 'per-instance manager token (default: env SELFHELP_MANAGER_TOKEN)')
  .option('--watch', 'keep running, draining pending operations every --interval seconds (for systemd/supervised use)', false)
  .option('--interval <seconds>', 'poll interval in --watch mode (default 15)', (v) => parseInt(v, 10), 15)
  .action(async (id: string, opts) => {
    try {
      const token = (opts.token as string | undefined) ?? process.env.SELFHELP_MANAGER_TOKEN;
      if (!token) {
        throw new Error('A per-instance manager token is required (--token or SELFHELP_MANAGER_TOKEN).');
      }
      const d = await deps(program.opts().root as string);
      const client = new HttpBackendOperationsClient({
        backendBaseUrl: opts.backendUrl as string,
        managerToken: token,
        instanceId: id,
      });
      const drainOnce = async () => {
        const outcomes = await drainInstanceOperations(d, id, client);
        if (outcomes.length === 0) {
          console.log(`No pending operations for ${id}.`);
          return;
        }
        for (const outcome of outcomes) {
          if (outcome.result === 'rejected') {
            console.log(`Operation ${outcome.operationId} rejected (${outcome.status}): ${outcome.reason}`);
          } else if (outcome.result === 'completed') {
            console.log(`Operation ${outcome.operationId} finished: ${outcome.status}.`);
          }
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
  .requiredOption('--domain <domain>', 'new domain for the clone')
  .option('--target-local-port <port>', 'published localhost port (cloning a local instance)', (v) => Number(v))
  .option('--no-preserve-versions', 'resolve latest compatible versions instead of pinning the source lock')
  .option('--no-uploads', 'do not copy uploads')
  .option('--no-plugins', 'do not copy plugin artifacts')
  .option('--apply', 'execute the clone: fresh secrets, copy DB + volumes, bring up, health-check', false)
  .action(async (source: string, target: string, opts) => {
    try {
      const d = await deps(program.opts().root as string);
      const res = await instanceClone(d, source, target, {
        targetDomain: opts.domain,
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
  .description('Create a local operator')
  .requiredOption('--email <email>', 'operator email')
  .requiredOption('--roles <roles>', 'comma-separated roles: server_owner,instance_operator,read_only')
  .option('--name <name>', 'display name')
  .option('--password <password>', 'operator password (or env SELFHELP_MANAGER_ADMIN_PASSWORD)')
  .action(async (opts) => {
    try {
      const password = (opts.password as string | undefined) ?? process.env.SELFHELP_MANAGER_ADMIN_PASSWORD;
      if (!password) throw new Error('A password is required (--password or SELFHELP_MANAGER_ADMIN_PASSWORD).');
      const store = fileOperatorStore(program.opts().root as string);
      const op = await adminCreate(store, {
        email: opts.email,
        displayName: (opts.name as string | undefined) ?? opts.email,
        password,
        roles: parseRoles(opts.roles as string),
      });
      console.log(`Created operator ${op.email} [${op.roles.join(', ')}].`);
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

program.parseAsync(process.argv).catch(fail);
