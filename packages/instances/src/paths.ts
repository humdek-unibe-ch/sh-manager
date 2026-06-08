// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';

export const DEFAULT_ROOT = '/opt/selfhelp';

export interface InstancePaths {
  dir: string;
  composePath: string;
  envPath: string;
  secretsDir: string;
  manifestPath: string;
  lockPath: string;
  uploadsDir: string;
  pluginsDir: string;
  backupsDir: string;
  logsDir: string;
  updateOpsDir: string;
  readmePath: string;
}

export function serverInventoryPath(root: string = DEFAULT_ROOT): string {
  return path.join(root, 'selfhelp.server.json');
}

export function proxyDir(root: string = DEFAULT_ROOT): string {
  return path.join(root, 'proxy');
}

export function instancesDir(root: string = DEFAULT_ROOT): string {
  return path.join(root, 'instances');
}

export function instancePaths(instanceId: string, root: string = DEFAULT_ROOT): InstancePaths {
  const dir = path.join(instancesDir(root), instanceId);
  return {
    dir,
    composePath: path.join(dir, 'compose.yaml'),
    envPath: path.join(dir, '.env'),
    secretsDir: path.join(dir, 'secrets'),
    manifestPath: path.join(dir, 'selfhelp.instance.json'),
    lockPath: path.join(dir, 'selfhelp.lock.json'),
    uploadsDir: path.join(dir, 'uploads'),
    pluginsDir: path.join(dir, 'plugins'),
    backupsDir: path.join(dir, 'backups'),
    logsDir: path.join(dir, 'logs'),
    updateOpsDir: path.join(dir, 'update-operations'),
    readmePath: path.join(dir, 'README.md'),
  };
}

/** Directories that must exist for a healthy instance layout. */
export function instanceDirectories(paths: InstancePaths): string[] {
  return [
    paths.dir,
    paths.secretsDir,
    paths.uploadsDir,
    paths.pluginsDir,
    paths.backupsDir,
    paths.logsDir,
    paths.updateOpsDir,
  ];
}
