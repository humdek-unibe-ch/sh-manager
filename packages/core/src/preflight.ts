// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Update preflight + resource checks. Pure function over already-collected
 * facts (resource probing is the side-effecting boundary in the CLI). Produces
 * an {@link UpdatePreflightResult} aligned with the shared contract.
 */
import type {
  DatabaseMigrationMetadata,
  PreflightCheck,
  PreflightOption,
  PreflightStatus,
  UpdatePreflightResult,
} from '@shm/schemas';

export interface PreflightResourceFacts {
  requiredPortsFree: { port: number; free: boolean }[];
  diskBytesFree: number;
  memoryBytesTotal: number;
  cpuCount: number;
  dockerAvailable: boolean;
  dockerComposeAvailable: boolean;
}

export interface PreflightThresholds {
  minDiskBytes: number;
  minMemoryBytes: number;
  minCpu: number;
}

export const DEFAULT_THRESHOLDS: PreflightThresholds = {
  minDiskBytes: 5 * 1024 * 1024 * 1024,
  minMemoryBytes: 2 * 1024 * 1024 * 1024,
  minCpu: 2,
};

export interface PreflightInput {
  instanceId: string;
  currentVersion: string;
  targetVersion: string;
  resources: PreflightResourceFacts;
  database: DatabaseMigrationMetadata;
  thresholds?: Partial<PreflightThresholds>;
  canDirectUpgrade?: boolean;
  advisoryBlocks?: string[];
  compatibilityBlocks?: string[];
  driftBlocks?: string[];
  options?: PreflightOption[];
}

function gib(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function deriveStatus(checks: PreflightCheck[]): PreflightStatus {
  if (checks.some((c) => c.severity === 'error')) return 'blocked';
  if (checks.some((c) => c.severity === 'warning')) return 'warning';
  return 'ok';
}

export function runPreflight(input: PreflightInput): UpdatePreflightResult {
  const t: PreflightThresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const r = input.resources;
  const checks: PreflightCheck[] = [];

  checks.push(
    r.dockerAvailable
      ? { code: 'docker.available', severity: 'info', message: 'Docker engine is available.' }
      : { code: 'docker.available', severity: 'error', message: 'Docker engine is not available.' },
  );
  checks.push(
    r.dockerComposeAvailable
      ? { code: 'docker.compose', severity: 'info', message: 'Docker Compose is available.' }
      : { code: 'docker.compose', severity: 'error', message: 'Docker Compose v2 is not available.' },
  );

  if (r.diskBytesFree < t.minDiskBytes) {
    checks.push({
      code: 'resources.disk',
      severity: 'error',
      message: `Insufficient free disk: ${gib(r.diskBytesFree)} (need at least ${gib(t.minDiskBytes)}).`,
    });
  } else if (r.diskBytesFree < t.minDiskBytes * 2) {
    checks.push({
      code: 'resources.disk',
      severity: 'warning',
      message: `Low free disk: ${gib(r.diskBytesFree)} (recommended ${gib(t.minDiskBytes * 2)}).`,
    });
  } else {
    checks.push({ code: 'resources.disk', severity: 'info', message: `Free disk: ${gib(r.diskBytesFree)}.` });
  }

  if (r.memoryBytesTotal < t.minMemoryBytes) {
    checks.push({
      code: 'resources.memory',
      severity: 'warning',
      message: `Low memory: ${gib(r.memoryBytesTotal)} (recommended ${gib(t.minMemoryBytes)}).`,
    });
  }
  if (r.cpuCount < t.minCpu) {
    checks.push({
      code: 'resources.cpu',
      severity: 'warning',
      message: `Low CPU count: ${r.cpuCount} (recommended ${t.minCpu}).`,
    });
  }

  const busyPorts = r.requiredPortsFree.filter((p) => !p.free).map((p) => p.port);
  if (busyPorts.length > 0) {
    checks.push({
      code: 'resources.ports',
      severity: 'error',
      // The shared Traefik proxy must bind these ports itself (it terminates TLS
      // and routes every instance), so another web server holding them is the
      // most common cause of "the domain does not load / no SSL". Name the usual
      // suspects and the fix so the operator does not have to guess.
      message:
        `Required port(s) already in use: ${busyPorts.join(', ')}. ` +
        `The shared SelfHelp Traefik proxy must own ${busyPorts.join(' and ')} on this host. ` +
        `Stop or relocate any other web server using them — most often Apache or nginx, e.g. ` +
        `"sudo systemctl disable --now apache2". Find the holder with "sudo ss -ltnp 'sport = :80'".`,
    });
  }

  if (input.canDirectUpgrade === false) {
    checks.push({
      code: 'upgrade.path',
      severity: 'error',
      message: `Cannot upgrade directly from ${input.currentVersion} to ${input.targetVersion}.`,
    });
  }

  for (const m of input.advisoryBlocks ?? []) checks.push({ code: 'security.advisory', severity: 'error', message: m });
  for (const m of input.compatibilityBlocks ?? []) checks.push({ code: 'compatibility', severity: 'error', message: m });
  for (const m of input.driftBlocks ?? []) checks.push({ code: 'inventory.drift', severity: 'error', message: m });

  if (input.database.destructive) {
    checks.push({
      code: 'database.destructive',
      severity: 'warning',
      message: 'Target version includes a destructive migration; a backup and manual confirmation are required.',
    });
  }
  if (input.database.requiresBackup) {
    checks.push({ code: 'database.backup', severity: 'info', message: 'A backup will be taken before migrations.' });
  }

  return {
    preflightVersion: 1,
    status: deriveStatus(checks),
    instanceId: input.instanceId,
    currentVersion: input.currentVersion,
    targetVersion: input.targetVersion,
    checks,
    options: input.options ?? [],
    database: {
      destructive: input.database.destructive,
      requiresBackup: input.database.requiresBackup,
      manualConfirmationRequired: input.database.manualConfirmationRequired,
    },
    rollback: {
      // MVP policy (distribution plan "Backup And Rollback"): automatic rollback
      // is only supported BEFORE migrations. After a destructive migration the
      // only recovery is restoring the verified backup, so this is always false.
      automaticBeforeMigrations: true,
      automaticAfterDestructiveMigrations: false,
    },
  };
}
