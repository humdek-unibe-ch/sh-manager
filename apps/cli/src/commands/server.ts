// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Server-level commands (`server init|status|start|logs|purge|run-scheduled-backups`).
 *
 * Verbatim move out of `bin.ts`; command names / args / options / help text
 * are byte-identical. The two bin-local helpers arrive via {@link CliContext}.
 */
import type { Command } from 'commander';
import type { InstanceMode } from '@shm/schemas';
import {
  instanceList,
  serverInit,
  serverStartProxy,
  serverProxyLogs,
  serverPurge,
  serverRunScheduledBackups,
  MANAGER_VERSION,
} from '@shm/app-actions';
import { formatSteps, formatTable } from '../output.js';
import type { CliContext } from './context.js';

export function registerServer(program: Command, ctx: CliContext): void {
  const { deps, fail } = ctx;
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
    .command('start')
    .description('(Re)start the shared Traefik proxy (production). Repairs a server whose proxy never started or was stopped — instances installed but unreachable.')
    .action(async () => {
      try {
        const d = await deps(program.opts().root as string);
        const res = await serverStartProxy(d);
        if (res.started) {
          console.log(`Shared Traefik proxy (re)started on network "${res.network}".`);
        } else {
          console.log('No production instance on this server — the shared proxy is only used in production (local instances route via published ports).');
        }
      } catch (err) {
        fail(err);
      }
    });

  server
    .command('logs')
    .description('Show recent (redacted) logs from the shared Traefik proxy — edge routing, ACME/TLS, and Docker-provider errors.')
    .option('-n, --tail <lines>', 'number of trailing lines (1-2000)', '200')
    .action(async (opts: { tail?: string }) => {
      try {
        const d = await deps(program.opts().root as string);
        const res = await serverProxyLogs(d, { tail: opts.tail !== undefined ? Number(opts.tail) : undefined });
        console.log(`# proxy (traefik) logs (last ${res.tail} lines) — ${res.readAt}`);
        console.log(res.text.trimEnd());
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
}
