// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Manager self-update check.
 *
 * The manager never replaces itself in place (the Docker image cannot swap its
 * own running container, and a source checkout is the operator's working
 * tree). Instead this module answers "is a newer manager released?" against
 * the official GitHub release feed and returns the exact commands for the
 * detected runtime. Both the CLI (`sh-manager self-update`) and the web UI
 * (`GET /api/manager/update-check`) surface the same result.
 */
import { existsSync } from 'node:fs';
import semver from 'semver';

export const MANAGER_RELEASES_LATEST_URL = 'https://api.github.com/repos/humdek-unibe-ch/sh-manager/releases/latest';
export const MANAGER_IMAGE = 'ghcr.io/humdek-unibe-ch/sh-manager';
export const MANAGER_REPO_URL = 'https://github.com/humdek-unibe-ch/sh-manager';

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
  /** Exact operator commands that apply the update for this runtime. */
  instructions: string[];
  /** Human-readable reason when the latest version could not be determined. */
  error?: string;
}

/** The update commands per runtime; pure so the UI/CLI/tests share one truth. */
export function selfUpdateInstructions(runtime: ManagerRuntime, latestVersion: string | null): string[] {
  if (runtime === 'docker') {
    const tag = latestVersion ? `v${latestVersion}` : 'latest';
    return [
      `docker pull ${MANAGER_IMAGE}:${tag}`,
      `docker pull ${MANAGER_IMAGE}:latest`,
      'Next docker run of the manager uses the new image; long-running process-operations loops must be restarted.',
    ];
  }
  return ['git pull', 'npm ci', 'npm run build'];
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
