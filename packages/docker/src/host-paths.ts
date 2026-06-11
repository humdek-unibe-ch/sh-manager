// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Container-to-engine path mapping.
 *
 * The manager usually runs inside its own container while driving the HOST's
 * Docker engine through the mounted socket. Every path it hands to the engine
 * (compose bind-mount sources, `docker run -v` backup mounts) is interpreted
 * by the ENGINE, not by the manager container. Historically that forced the
 * state folder to be mounted at the identical path on both sides
 * (`-v /opt/selfhelp:/opt/selfhelp`) — impossible to express nicely on
 * Windows, where the engine lives in the Docker Desktop VM and host drives
 * appear under `/run/desktop/mnt/host/<drive>/…`.
 *
 * This module removes that requirement: the manager inspects its OWN container
 * through the already-mounted socket, reads where the engine says the state
 * root is mounted from, and rewrites engine-bound paths accordingly. With a
 * same-path mount (the documented Linux production setup) the discovered
 * mapping is the identity and nothing changes.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HostPathMapping {
  /** State root as the manager process sees it (inside its container). */
  containerRoot: string;
  /** The same folder as the Docker engine sees it (valid bind-mount source). */
  engineRoot: string;
}

/** Forward slashes, no trailing slash (keeps `/` itself intact). */
function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/**
 * Rewrites a manager-container path under `containerRoot` to the engine's view
 * of the same file. Paths outside the mapping (or with no mapping at all) pass
 * through unchanged. Output always uses forward slashes — it is consumed by
 * the engine, never by the local filesystem.
 */
export function toEnginePath(containerPath: string, mapping?: HostPathMapping): string {
  if (!mapping) return containerPath;
  const p = normalizePath(containerPath);
  const root = normalizePath(mapping.containerRoot);
  if (p !== root && !p.startsWith(`${root}/`)) return containerPath;
  const engineRoot = normalizePath(mapping.engineRoot);
  return p === root ? engineRoot : `${engineRoot}${p.slice(root.length)}`;
}

interface InspectedMount {
  Destination?: string;
  Source?: string;
}

/**
 * Derives the mapping from a container's inspected mounts (the JSON of
 * `docker inspect <self> --format '{{json .Mounts}}'`). Returns undefined when
 * the root is not bind-mounted or is mounted at the same path on both sides
 * (identity — no translation needed).
 */
export function mappingFromMounts(root: string, mountsJson: string): HostPathMapping | undefined {
  let mounts: InspectedMount[];
  try {
    const parsed = JSON.parse(mountsJson) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    mounts = parsed as InspectedMount[];
  } catch {
    return undefined;
  }
  const wanted = normalizePath(root);
  for (const m of mounts) {
    if (typeof m.Destination !== 'string' || typeof m.Source !== 'string') continue;
    if (normalizePath(m.Destination) !== wanted) continue;
    const source = normalizePath(m.Source);
    if (source === wanted) return undefined;
    return { containerRoot: root, engineRoot: source };
  }
  return undefined;
}

export interface EngineRootDiscoveryOptions {
  /** State root as this process sees it (e.g. `/opt/selfhelp`). */
  root: string;
  /** Env source (tests inject; defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Containerization check (defaults to the `/.dockerenv` marker). */
  isContainerized?: () => boolean;
  /** Returns `{{json .Mounts}}` for this container (defaults to `docker inspect $(hostname)`). */
  inspectSelfMounts?: () => Promise<string>;
}

async function realInspectSelfMounts(): Promise<string> {
  // A container's default hostname is its own container id, so the mounted
  // socket lets the manager inspect itself without any extra configuration.
  const { stdout } = await execFileAsync('docker', ['inspect', os.hostname(), '--format', '{{json .Mounts}}']);
  return stdout;
}

/**
 * Discovers how the engine sees the state root.
 *
 * Order: `SELFHELP_ENGINE_ROOT` override (`off` disables translation), then —
 * only when containerized — self-inspection through the Docker socket. Any
 * failure degrades to "no mapping", which preserves the long-standing
 * same-path-mount behaviour.
 */
export async function discoverEngineRoot(opts: EngineRootDiscoveryOptions): Promise<HostPathMapping | undefined> {
  const env = opts.env ?? process.env;
  const override = env.SELFHELP_ENGINE_ROOT;
  if (override !== undefined && override !== '') {
    if (override === 'off') return undefined;
    if (normalizePath(override) === normalizePath(opts.root)) return undefined;
    return { containerRoot: opts.root, engineRoot: override };
  }
  const containerized = opts.isContainerized ? opts.isContainerized() : existsSync('/.dockerenv');
  if (!containerized) return undefined;
  try {
    return mappingFromMounts(opts.root, await (opts.inspectSelfMounts ?? realInspectSelfMounts)());
  } catch {
    return undefined;
  }
}
