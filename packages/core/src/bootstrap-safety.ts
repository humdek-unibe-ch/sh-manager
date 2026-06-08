// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Bootstrap target safety: a clean server may be bootstrapped freely, but an
 * already-managed server (inventory present) or a partial/foreign install
 * (SelfHelp artifacts without an inventory) must NOT be silently overwritten.
 * Re-bootstrapping requires an explicit import/repair acknowledgement.
 *
 * Pure over already-collected facts; the impure filesystem/Docker discovery is
 * the CLI boundary (apps/cli/src/actions.ts + env.ts).
 */
export interface BootstrapTargetFacts {
  /** `selfhelp.server.json` exists at the root. */
  inventoryExists: boolean;
  /** A proxy compose file exists at the root. */
  proxyComposeExists: boolean;
  /** Instance directories discovered under `<root>/instances`. */
  instanceDirsOnDisk: string[];
  /** Docker compose projects bearing SelfHelp labels (optional discovery). */
  dockerProjects?: string[];
  /** Docker volumes bearing SelfHelp labels (optional discovery). */
  dockerVolumes?: string[];
  /** Docker networks bearing SelfHelp labels (optional discovery). */
  dockerNetworks?: string[];
}

export type BootstrapDecision = 'clean' | 'existing-managed' | 'conflict';

export interface BootstrapAssessment {
  decision: BootstrapDecision;
  findings: string[];
}

function countOptional(list: string[] | undefined): number {
  return list?.length ?? 0;
}

export function assessBootstrapTarget(facts: BootstrapTargetFacts): BootstrapAssessment {
  const findings: string[] = [];
  if (facts.inventoryExists) findings.push('A server inventory (selfhelp.server.json) already exists.');
  if (facts.proxyComposeExists) findings.push('A proxy compose file already exists.');
  if (facts.instanceDirsOnDisk.length > 0) {
    findings.push(`Instance director${facts.instanceDirsOnDisk.length === 1 ? 'y' : 'ies'} on disk: ${facts.instanceDirsOnDisk.join(', ')}.`);
  }
  for (const p of facts.dockerProjects ?? []) findings.push(`Existing SelfHelp compose project: ${p}.`);
  for (const v of facts.dockerVolumes ?? []) findings.push(`Existing SelfHelp volume: ${v}.`);
  for (const n of facts.dockerNetworks ?? []) findings.push(`Existing SelfHelp network: ${n}.`);

  // An inventory means the server is already managed: use instance commands or
  // an explicit import, never a fresh bootstrap that clobbers it.
  if (facts.inventoryExists) return { decision: 'existing-managed', findings };

  // Artifacts without an inventory == partial or foreign install. Refuse to
  // overwrite; the operator must import/repair explicitly.
  const anyArtifacts =
    facts.proxyComposeExists ||
    facts.instanceDirsOnDisk.length > 0 ||
    countOptional(facts.dockerProjects) > 0 ||
    countOptional(facts.dockerVolumes) > 0 ||
    countOptional(facts.dockerNetworks) > 0;
  if (anyArtifacts) return { decision: 'conflict', findings };

  return { decision: 'clean', findings: [] };
}

export class BootstrapConflictError extends Error {
  constructor(readonly assessment: BootstrapAssessment) {
    const lead =
      assessment.decision === 'existing-managed'
        ? 'This server is already bootstrapped. Use instance commands, or re-run with import to reconcile.'
        : 'Existing SelfHelp artifacts were detected without a server inventory (partial or foreign install). Refusing to overwrite; resolve or import first.';
    super(`${lead}\n` + assessment.findings.map((f) => `- ${f}`).join('\n'));
    this.name = 'BootstrapConflictError';
  }
}

export interface BootstrapSafetyOptions {
  /** Operator explicitly acknowledged import/repair of an existing target. */
  allowImport?: boolean;
}

/**
 * Throws {@link BootstrapConflictError} unless the target is clean or the
 * operator explicitly opted into import/repair. Destructive bootstrap is blocked
 * until drift is resolved.
 */
export function assertSafeToBootstrap(
  assessment: BootstrapAssessment,
  opts: BootstrapSafetyOptions = {},
): void {
  if (assessment.decision === 'clean') return;
  if (opts.allowImport) return;
  throw new BootstrapConflictError(assessment);
}
