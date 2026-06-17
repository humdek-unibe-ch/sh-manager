// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance-level commands (install / health / update / backup / restore / clone / lifecycle / logs / repair / safe-mode / plugin-recover).
 *
 * Verbatim move out of `bin.ts`; command names / args / options / help text
 * are byte-identical. The two bin-local helpers arrive via {@link CliContext}.
 */
import type { Command } from 'commander';
import type { InstanceMode, ReleaseChannel } from '@shm/schemas';
import { OFFICIAL_REGISTRY_URL } from '@shm/registry';
import { instancePaths, type RemoveMode } from '@shm/instances';
import { DEFAULT_BACKUP_SCHEDULE, type RestoreMode } from '@shm/backup';
import {
  instanceBackup,
  instanceBackupPrune,
  instanceBackupScheduleGet,
  instanceBackupScheduleSet,
  instanceClone,
  instanceGetEnv,
  instanceSetAddress,
  instanceSetEnv,
  instanceSetName,
  instanceGetMailer,
  instanceHealth,
  instanceInstall,
  instanceList,
  instanceEnable,
  instanceRemove,
  instanceRepair,
  instanceRestore,
  instanceSafeMode,
  instancePluginRecover,
  instanceSetMailer,
  instanceSupportBundle,
  instanceLogs,
  LOG_SERVICES,
  instanceUpdate,
  instanceFrontendUpdate,
  drainInstanceOperations,
  drainInstancePluginOperations,
  ComposeExecBackendOperationsClient,
  HttpBackendOperationsClient,
  type LogService,
  type BackupScheduleStatus,
} from '@shm/app-actions';
import { formatHealth, formatPreflight, formatSteps, formatTable } from '../output.js';
import type { CliContext } from './context.js';

export function registerInstance(program: Command, ctx: CliContext): void {
  const { deps, fail } = ctx;
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
          log: (line) => console.log(line),
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
    .command('rename <id> <displayName>')
    .description("Rename an instance's display name only (metadata; the technical id and all data are untouched)")
    .action(async (id: string, displayName: string) => {
      try {
        const d = await deps(program.opts().root as string);
        const res = await instanceSetName(d, id, { displayName });
        console.log(
          res.changed
            ? `Renamed: "${res.previousName}" -> "${res.displayName}" (id "${id}" unchanged).`
            : `Display name unchanged ("${res.displayName}").`,
        );
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
    .command('enable <id>')
    .description('Bring a disabled (or removed-keep-data) instance back online')
    .action(async (id: string) => {
      try {
        const d = await deps(program.opts().root as string);
        const res = await instanceEnable(d, id);
        if (!res.executed) {
          console.error(formatSteps(`Enable blocked for ${id}:`, res.errors));
          process.exit(1);
        }
        console.log(formatSteps(`Enabled ${id}:`, res.steps));
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
    .command('logs <id>')
    .description(`Show recent (redacted) container logs for a service [${LOG_SERVICES.join(', ')}]`)
    .option('-s, --service <service>', 'service to read logs from', 'backend')
    .option('-n, --tail <lines>', 'number of trailing lines (1-2000)', '200')
    .action(async (id: string, opts: { service?: string; tail?: string }) => {
      try {
        const res = await instanceLogs(await deps(program.opts().root as string), id, {
          service: opts.service as LogService | undefined,
          tail: opts.tail !== undefined ? Number(opts.tail) : undefined,
        });
        console.log(`# ${res.service} logs (last ${res.tail} lines) — ${res.instanceId} @ ${res.readAt}`);
        console.log(res.text.trimEnd());
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

  instance
    .command('plugin-recover <id>')
    .description('Recover a backend that crash-loops after a half-removed plugin ("Class ...Bundle not found"): boot in safe mode, finalize the pending uninstall, repair the bundle registration from the database, then verify a clean boot')
    .option('--keep-safe-mode', 'leave safe mode enabled at the end (inspect before re-enabling plugins)', false)
    .action(async (id: string, opts) => {
      try {
        const d = await deps(program.opts().root as string);
        const res = await instancePluginRecover(d, id, {
          log: (l) => console.log(l),
          keepSafeMode: opts.keepSafeMode as boolean,
        });
        console.log(`\nPlugin recovery for ${id}:`);
        for (const step of res.steps) console.log(`  ${step}`);
        if (res.recovered) {
          console.log('\nThe backend now boots cleanly with plugins enabled.');
        } else if (res.safeModeLeftEnabled) {
          console.log(
            `\nThe backend is UP in safe mode (plugins disabled) but does not yet boot cleanly with plugins.\n` +
              `Re-trigger the plugin uninstall from the CMS admin (reachable now), then run this command again,\n` +
              `or restore a backup. When fixed, run: sh-manager instance safe-mode disable ${id}`,
          );
        }
      } catch (err) {
        fail(err);
      }
    });
}
