// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Manager self-update: check + apply.
 *
 * {@link checkSelfUpdate} answers "is a newer manager released?" against the
 * official GitHub release feed. {@link applySelfUpdate} then performs the
 * update for the detected runtime:
 *
 * - **docker** (the published image): pull the new image tags through the
 *   mounted Docker socket, then recreate the long-running `sh-manager-web`
 *   GUI container on the new image with its original ports/mounts/arguments
 *   (one-shot CLI containers pick the new image up on their next run).
 *   A container cannot replace ITSELF mid-process, so when the updater runs
 *   inside `sh-manager-web` it pulls and reports instead of self-killing.
 * - **source** (a git checkout): run `git pull --ff-only && npm ci &&
 *   npm run build` in the checkout.
 *
 * All process/Docker access is injected ({@link ExecLike}) so every path is
 * unit-testable offline. Both the CLI (`sh-manager self-update`) and the web
 * UI (`GET /api/manager/update-check`) surface the same check result.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import semver from 'semver';

export const MANAGER_RELEASES_LATEST_URL = 'https://api.github.com/repos/humdek-unibe-ch/sh-manager/releases/latest';
export const MANAGER_IMAGE = 'ghcr.io/humdek-unibe-ch/sh-manager';
export const MANAGER_REPO_URL = 'https://github.com/humdek-unibe-ch/sh-manager';
/** Name the wrapper script gives the long-running GUI container. */
export const WEB_CONTAINER_NAME = 'sh-manager-web';

/** How this manager process is being run. */
export type ManagerRuntime = 'docker' | 'source';

/** A Docker container ships `/.dockerenv`; a source checkout does not. */
export function detectManagerRuntime(): ManagerRuntime {
  return existsSync('/.dockerenv') ? 'docker' : 'source';
}

export interface SelfUpdateCheck {
  currentVersion: string;
  /** Latest released version, or null when the feed was unreachable. */
  latestVersion: string | null;
  updateAvailable: boolean;
  runtime: ManagerRuntime;
  /** Release page of the latest version (when known). */
  releaseUrl?: string;
  /** What `sh-manager self-update` will do / the manual fallback commands. */
  instructions: string[];
  /** Human-readable reason when the latest version could not be determined. */
  error?: string;
}

/** The update commands per runtime; pure so the UI/CLI/tests share one truth. */
export function selfUpdateInstructions(runtime: ManagerRuntime, latestVersion: string | null): string[] {
  if (runtime === 'docker') {
    const tag = latestVersion ? `v${latestVersion}` : 'latest';
    return [
      'sh-manager self-update   (pulls the new image and restarts the sh-manager-web GUI container)',
      `manual: docker pull ${MANAGER_IMAGE}:${tag} && docker pull ${MANAGER_IMAGE}:latest, then restart the GUI container`,
    ];
  }
  return [
    'sh-manager self-update   (runs git pull --ff-only, npm ci, npm run build in the checkout)',
    'manual: git pull && npm ci && npm run build',
  ];
}

interface LatestReleaseResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<LatestReleaseResponse>;

export interface SelfUpdateOptions {
  currentVersion: string;
  runtime?: ManagerRuntime;
  fetchImpl?: FetchLike;
  latestUrl?: string;
}

/**
 * Compares the running version against the latest published GitHub release.
 * Network failures degrade to `latestVersion: null` + `error` (never a throw):
 * an offline server must still be able to run every other command.
 */
export async function checkSelfUpdate(opts: SelfUpdateOptions): Promise<SelfUpdateCheck> {
  const runtime = opts.runtime ?? detectManagerRuntime();
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const url = opts.latestUrl ?? MANAGER_RELEASES_LATEST_URL;
  const currentVersion = opts.currentVersion;

  const unresolved = (error: string): SelfUpdateCheck => ({
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    runtime,
    instructions: selfUpdateInstructions(runtime, null),
    error,
  });

  let body: unknown;
  try {
    const res = await doFetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sh-manager' } });
    if (!res.ok) return unresolved(`Release feed returned HTTP ${res.status}.`);
    body = await res.json();
  } catch (err) {
    return unresolved(`Release feed unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const tag = (body as { tag_name?: unknown }).tag_name;
  const htmlUrl = (body as { html_url?: unknown }).html_url;
  const latest = typeof tag === 'string' ? (semver.coerce(tag)?.version ?? null) : null;
  if (!latest) return unresolved('Could not parse the latest release tag.');

  const current = semver.coerce(currentVersion)?.version ?? '0.0.0';
  const updateAvailable = semver.gt(latest, current);
  return {
    currentVersion,
    latestVersion: latest,
    updateAvailable,
    runtime,
    ...(typeof htmlUrl === 'string' ? { releaseUrl: htmlUrl } : {}),
    instructions: updateAvailable ? selfUpdateInstructions(runtime, latest) : [],
  };
}

/** Renders the CLI output lines for a check result. */
export function formatSelfUpdate(check: SelfUpdateCheck): string {
  const lines: string[] = [`SelfHelp Manager ${check.currentVersion} (${check.runtime === 'docker' ? 'Docker image' : 'source checkout'})`];
  if (check.error) {
    lines.push(`Could not determine the latest release: ${check.error}`);
    lines.push(`Check ${MANAGER_REPO_URL}/releases manually.`);
    return lines.join('\n');
  }
  if (!check.updateAvailable) {
    lines.push(`Up to date (latest release: ${check.latestVersion}).`);
    return lines.join('\n');
  }
  lines.push(`Update available: ${check.latestVersion}${check.releaseUrl ? ` (${check.releaseUrl})` : ''}`);
  lines.push('To update, run:');
  for (const i of check.instructions) lines.push(`  ${i}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/** Injected process runner so the apply paths are unit-testable offline. */
export type ExecLike = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

/**
 * Real exec. `npm` on Windows is `npm.cmd`, which Node refuses to spawn
 * without a shell since the CVE-2024-27980 hardening — hence the shell hop
 * for .cmd shims only.
 */
export const realExec: ExecLike = async (cmd, args, opts = {}) => {
  const isWinCmdShim = process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx');
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    maxBuffer: 32 * 1024 * 1024,
    ...(isWinCmdShim ? { shell: true } : {}),
  });
  return { stdout, stderr };
};

export interface ApplySelfUpdateOptions {
  exec?: ExecLike;
  /** Manager image repository (default: the official GHCR image). */
  image?: string;
  /** GUI container name (default: `sh-manager-web`, as created by the wrapper). */
  webContainerName?: string;
  /** Source checkout root for source-runtime updates (default: this repo). */
  repoRoot?: string;
  /**
   * Identity of the container THIS process runs in (default: the hostname,
   * which Docker sets to the short container id). Guards against the updater
   * force-removing its own container mid-run.
   */
  selfContainerId?: string;
}

export interface ApplySelfUpdateResult {
  /** True when the new version was pulled/built successfully. */
  applied: boolean;
  /** Ordered human-readable record of what ran. */
  steps: string[];
  /** True when the `sh-manager-web` GUI container was recreated on the new image. */
  webRestarted: boolean;
  /** Set when the GUI container exists but was deliberately not (or could not be) restarted. */
  webRestartHint?: string;
}

/** The subset of `docker inspect` the GUI-container recreate needs. */
interface WebContainerInfo {
  id: string;
  /** Image REFERENCE the container was created from (`Config.Image`). */
  image: string;
  /** Image ID (sha256) the container is actually running (`.Image`). */
  imageId: string;
  cmd: string[];
  env: string[];
  binds: string[];
  portBindings: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  extraHosts: string[];
  autoRemove: boolean;
  restartPolicy: string;
}

async function inspectWebContainer(exec: ExecLike, name: string): Promise<WebContainerInfo | null> {
  let raw: string;
  try {
    raw = (await exec('docker', ['inspect', name, '--format', '{{json .}}'])).stdout;
  } catch {
    return null; // No such container — nothing to restart.
  }
  try {
    const j = JSON.parse(raw) as {
      Id?: string;
      Image?: string;
      Config?: { Image?: string; Cmd?: string[] | null; Env?: string[] | null };
      HostConfig?: {
        Binds?: string[] | null;
        PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
        ExtraHosts?: string[] | null;
        AutoRemove?: boolean;
        RestartPolicy?: { Name?: string };
      };
    };
    return {
      id: j.Id ?? '',
      image: j.Config?.Image ?? '',
      imageId: j.Image ?? '',
      cmd: j.Config?.Cmd ?? [],
      env: j.Config?.Env ?? [],
      binds: j.HostConfig?.Binds ?? [],
      portBindings: j.HostConfig?.PortBindings ?? {},
      extraHosts: j.HostConfig?.ExtraHosts ?? [],
      autoRemove: j.HostConfig?.AutoRemove ?? false,
      restartPolicy: j.HostConfig?.RestartPolicy?.Name ?? 'no',
    };
  } catch {
    return null; // Unparseable inspect output — treat as not restartable.
  }
}

/**
 * The image reference the recreated GUI container should run. A container on a
 * pinned OFFICIAL version tag is moved to the new version tag; `:latest` and
 * custom references are reused as-is (the pull above refreshed `:latest`).
 */
export function nextWebImage(currentRef: string, image: string, latestVersion: string | null): string {
  if (latestVersion && currentRef.startsWith(`${image}:v`)) return `${image}:v${latestVersion}`;
  return currentRef;
}

/** `docker run` args that recreate the GUI container on `newImage`. */
export function webRunArgs(info: WebContainerInfo, name: string, newImage: string): string[] {
  const args = ['run', '-d', '--name', name];
  if (info.autoRemove) args.push('--rm');
  else if (info.restartPolicy && info.restartPolicy !== 'no') args.push('--restart', info.restartPolicy);
  for (const bind of info.binds) args.push('-v', bind);
  for (const [portProto, hostList] of Object.entries(info.portBindings)) {
    const [containerPort, proto] = portProto.split('/');
    for (const h of hostList ?? []) {
      const hostPart = `${h.HostIp ? `${h.HostIp}:` : ''}${h.HostPort ?? containerPort}`;
      args.push('-p', `${hostPart}:${containerPort}${proto && proto !== 'tcp' ? `/${proto}` : ''}`);
    }
  }
  for (const host of info.extraHosts) args.push('--add-host', host);
  // Only operator-intent env survives the recreate; everything else comes from
  // the (new) image itself.
  for (const e of info.env) {
    if (e.startsWith('SHM_') || e.startsWith('SELFHELP_')) args.push('-e', e);
  }
  args.push(newImage, ...info.cmd);
  return args;
}

/**
 * Applies an available update for the runtime in `check` (see module docs).
 * Throws when the core update itself fails (pull/git/npm); a GUI-container
 * restart problem never fails the apply — it degrades to `webRestartHint`.
 */
export async function applySelfUpdate(check: SelfUpdateCheck, opts: ApplySelfUpdateOptions = {}): Promise<ApplySelfUpdateResult> {
  const exec = opts.exec ?? realExec;
  const steps: string[] = [];

  if (check.runtime === 'source') {
    const repoRoot = opts.repoRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    await exec('git', ['pull', '--ff-only'], { cwd: repoRoot });
    steps.push('git pull --ff-only');
    await exec('npm', ['ci'], { cwd: repoRoot });
    steps.push('npm ci');
    await exec('npm', ['run', 'build'], { cwd: repoRoot });
    steps.push('npm run build');
    return {
      applied: true,
      steps,
      webRestarted: false,
      webRestartHint: 'Restart any running `sh-manager web` process to load the new version.',
    };
  }

  const image = opts.image ?? MANAGER_IMAGE;
  const webName = opts.webContainerName ?? WEB_CONTAINER_NAME;

  // Pull the pinned version tag first (fails loudly if the release is broken),
  // then refresh :latest so wrapper scripts and next runs pick it up.
  if (check.latestVersion) {
    await exec('docker', ['pull', `${image}:v${check.latestVersion}`]);
    steps.push(`docker pull ${image}:v${check.latestVersion}`);
  }
  await exec('docker', ['pull', `${image}:latest`]);
  steps.push(`docker pull ${image}:latest`);

  const info = await inspectWebContainer(exec, webName);
  if (!info) {
    return { applied: true, steps, webRestarted: false };
  }

  // Never `docker rm -f` the container this very process lives in: the update
  // would kill itself halfway. The operator restarts the GUI (next wrapper
  // call uses the new image). Docker sets a container's hostname to its short
  // id; outside a container there is no self id to collide with.
  const selfId = opts.selfContainerId ?? (existsSync('/.dockerenv') ? os.hostname() : '');
  if (selfId && info.id.startsWith(selfId)) {
    return {
      applied: true,
      steps,
      webRestarted: false,
      webRestartHint:
        `The GUI container (${webName}) is running this updater, so it was not restarted. ` +
        'Stop it and start it again (e.g. re-run `shm web`) to load the new image.',
    };
  }

  const newImage = nextWebImage(info.image, image, check.latestVersion);

  // Restart only when the container is actually behind the freshly pulled
  // image. This also catches a GUI container created from an OLDER `:latest`
  // while the manager version itself is already current (the pulls above were
  // then no-ops). When the image-id comparison is impossible, fall back to
  // "restart when a newer version was just pulled".
  let stale = check.updateAvailable;
  try {
    const targetId = (await exec('docker', ['image', 'inspect', newImage, '--format', '{{.Id}}'])).stdout.trim();
    if (targetId) stale = info.imageId !== targetId;
  } catch {
    /* keep the fallback */
  }
  if (!stale) {
    return {
      applied: true,
      steps,
      webRestarted: false,
      webRestartHint: `The GUI container (${webName}) is already running the current image.`,
    };
  }

  try {
    await exec('docker', ['rm', '-f', webName]);
    steps.push(`docker rm -f ${webName}`);
    await exec('docker', webRunArgs(info, webName, newImage));
    steps.push(`docker run -d --name ${webName} ${newImage} (ports/mounts/args preserved)`);
    return { applied: true, steps, webRestarted: true };
  } catch (err) {
    return {
      applied: true,
      steps,
      webRestarted: false,
      webRestartHint:
        `The new image was pulled, but restarting the GUI container failed: ` +
        `${err instanceof Error ? err.message : String(err)}. Start it again manually (e.g. re-run \`shm web\`).`,
    };
  }
}
