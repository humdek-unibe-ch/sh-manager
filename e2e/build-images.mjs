// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Build the four SelfHelp test images locally from sibling source repos:
 *   - backend  (sh-selfhelp_backend/docker/Dockerfile, target `backend`)
 *   - worker   (same Dockerfile, target `worker`)
 *   - scheduler(same Dockerfile, target `scheduler`)
 *   - frontend (sh-selfhelp_frontend/Dockerfile)
 *
 * They are tagged with the same ghcr names the registry uses, but a fixed `:e2e`
 * tag, so the generated compose references local images (never pulled). Used by
 * the manager Docker e2e and by the dummy-level rehearsal runbook.
 *
 * Usage (standalone):
 *   node e2e/build-images.mjs [--backend-repo <path>] [--frontend-repo <path>] [--owner <o>] [--tag <t>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MANAGER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_OWNER = 'humdek-unibe-ch';
export const E2E_TAG = 'e2e';

/** The four image tags for a given owner + tag (shared by the registry builder). */
export function imageTags(owner = DEFAULT_OWNER, tag = E2E_TAG) {
  const t = (svc) => `ghcr.io/${owner}/selfhelp-${svc}:${tag}`;
  return { backend: t('backend'), worker: t('worker'), scheduler: t('scheduler'), frontend: t('frontend') };
}

/** Auto-detect the sibling source repos next to the manager checkout. */
export function defaultRepos() {
  const parent = path.join(MANAGER_ROOT, '..');
  return {
    backend: path.join(parent, 'sh-selfhelp_backend'),
    frontend: path.join(parent, 'sh-selfhelp_frontend'),
  };
}

function run(cmd, args, cwd) {
  process.stderr.write(`$ (${cwd}) ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/** Build all four images; returns the tag map. Throws if a repo is missing. */
export function buildImages(opts = {}) {
  const owner = opts.owner ?? DEFAULT_OWNER;
  const tag = opts.tag ?? E2E_TAG;
  const repos = { ...defaultRepos(), ...(opts.repos ?? {}) };

  if (!existsSync(path.join(repos.backend, 'docker', 'Dockerfile'))) {
    throw new Error(`backend repo not found at ${repos.backend} (pass --backend-repo / { repos.backend }).`);
  }
  if (!existsSync(path.join(repos.frontend, 'Dockerfile'))) {
    throw new Error(`frontend repo not found at ${repos.frontend} (pass --frontend-repo / { repos.frontend }).`);
  }

  const tags = imageTags(owner, tag);
  for (const target of ['backend', 'worker', 'scheduler']) {
    run('docker', ['build', '-f', 'docker/Dockerfile', '--target', target, '-t', tags[target], '.'], repos.backend);
    // Fail fast: the Symfony kernel must boot with no host env mounted. A
    // broken image (e.g. missing /app/.env) would otherwise surface only as
    // 240s backend-health timeouts deep inside the e2e journey.
    run('docker', ['run', '--rm', tags[target], 'php', 'bin/console', 'about'], repos.backend);
  }
  run('docker', ['build', '-f', 'Dockerfile', '-t', tags.frontend, '.'], repos.frontend);
  return tags;
}

function parseFlags(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const k = tok.slice(2);
      const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const a = parseFlags(process.argv.slice(2));
    const repos = {};
    if (typeof a['backend-repo'] === 'string') repos.backend = a['backend-repo'];
    if (typeof a['frontend-repo'] === 'string') repos.frontend = a['frontend-repo'];
    const tags = buildImages({
      ...(typeof a.owner === 'string' ? { owner: a.owner } : {}),
      ...(typeof a.tag === 'string' ? { tag: a.tag } : {}),
      repos,
    });
    process.stdout.write(JSON.stringify(tags, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`build-images.mjs: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
