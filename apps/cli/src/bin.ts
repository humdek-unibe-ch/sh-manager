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
import { Command, Option } from 'commander';
import { CrossInstanceError } from '@shm/core';
import { discoverEngineRoot } from '@shm/docker';
import {
  applySelfUpdate,
  checkSelfUpdate,
  doctor,
  formatSelfUpdate,
  loadTrustedKeys,
  MANAGER_VERSION,
  realDeps,
} from '@shm/app-actions';
import { stripRedundantManagerToken } from './argv.js';
import { formatPreflight } from './output.js';
import { describeRunningOperation, findRunningOperations } from './server-busy.js';
import { generateWrapperScript, type WrapperShell } from './wrapper.js';
import { registerServer } from './commands/server.js';
import { registerInstance } from './commands/instance.js';
import { registerAdmin } from './commands/admin.js';
import type { CliContext } from './commands/context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = process.env.SELFHELP_ROOT ?? '/opt/selfhelp';
// After the GUI container is recreated on the new image, the browser still
// holds the previously loaded single-page app until it reloads. Tell the
// operator how to pick up the new GUI — and that an SSH tunnel does NOT need to
// be torn down (it forwards to the host port the new container re-publishes).
const GUI_RELOAD_HINT =
  'Reload the manager GUI in your browser to load the new version (hard refresh: Ctrl/Cmd+Shift+R). ' +
  'You do not need to stop your SSH tunnel — it keeps forwarding to the recreated container.';
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
if (argv.length === 3 && ['--version', '-V', 'version'].includes(argv[2]!)) {
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
  .option('--force', 'apply even while instance operations are running (use only if the journal is stale)', false)
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
      // Refuse to recreate the GUI container while a mutating operation is in
      // flight: doing so kills it half-way (this is how a half-removed plugin /
      // half-applied update happens). `--force` is the escape for stale entries.
      const ensureIdle = async (): Promise<boolean> => {
        if (opts.force) return true;
        const running = await findRunningOperations(program.opts().root as string);
        if (running.length === 0) return true;
        console.error('\nRefusing to self-update: instance operations are in progress.');
        console.error('A self-update recreates the manager web container and would interrupt them,');
        console.error('which can leave an instance half-updated (e.g. a half-removed plugin).');
        for (const op of running) console.error(`  - ${describeRunningOperation(op)}`);
        console.error('\nWait for them to finish and retry. If these entries are stale (a crashed');
        console.error('manager left them behind), re-run with --force.');
        process.exitCode = 1;
        return false;
      };
      if (!check.updateAvailable) {
        if (check.runtime !== 'docker') return;
        if (!(await ensureIdle())) return;
        // The manager version is current, but the long-running GUI container
        // may still run an older image (created before the last pull) —
        // reconcile it so "self-update says up to date" implies "the GUI is
        // up to date" too.
        const result = await applySelfUpdate(check);
        if (result.webRestarted) {
          console.log('The web GUI container was on an older image and has been restarted on the current one.');
          console.log(GUI_RELOAD_HINT);
        } else if (result.webRestartHint) {
          console.log(result.webRestartHint);
        }
        return;
      }
      if (!(await ensureIdle())) return;
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
      if (result.webRestarted) console.log(GUI_RELOAD_HINT);
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


const ctx: CliContext = { deps, fail };
registerServer(program, ctx);
registerInstance(program, ctx);
registerAdmin(program, ctx);

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
