// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Operator-admin commands (`admin create|disable|role grant|role list|bootstrap-token`).
 *
 * Verbatim move out of `bin.ts`; command names / args / options / help text
 * are byte-identical. The two bin-local helpers arrive via {@link CliContext}.
 */
import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import { formatTable } from '../output.js';
import { adminBootstrapToken, adminCreate, adminDisable, adminList, adminRoleGrant, fileOperatorStore, parseRoles } from '../admin.js';
import type { ManagerRole } from '@shm/auth';
import type { CliContext } from './context.js';

export function registerAdmin(program: Command, ctx: CliContext): void {
  const { fail } = ctx;
  const admin = program.command('admin').description('Manage manager operators (local email + password auth)');

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
        // When `generated` is undefined, `provided` was a non-empty string; tsc
        // cannot correlate the two branches, so the non-null assertion is needed.
        const password = generated ?? provided!;
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
}
