// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Side-effect seam for the bootstrap server.
 *
 * The HTTP layer never touches Docker, the network, or the filesystem
 * directly: it depends on this interface so it stays unit-testable with fakes.
 * The composition root (`bin.ts`) supplies a real implementation that runs the
 * `sh-manager` CLI (the single Docker-access surface) and lightweight probes.
 */
import type { BootstrapPlan, CheckResult } from './wizard.js';

export interface DockerCheck {
  dockerAvailable: boolean;
  dockerComposeAvailable: boolean;
}

export interface RegistryCheck {
  ok: boolean;
  signatureVerified: boolean;
  detail?: string;
}

export interface ResourceCheck {
  /** Mirrors the preflight status: ok | warning | blocked. */
  status: 'ok' | 'warning' | 'blocked';
  detail?: string;
}

export interface InstallOutcome {
  ok: boolean;
  instanceDir?: string;
  version?: string;
  /** Public URL the operator visits once the stack is up. */
  publicUrl?: string;
  detail?: string;
}

export interface HealthOutcome {
  healthy: boolean;
  degraded: boolean;
  detail?: string;
}

export interface BootstrapActions {
  checkDocker(): Promise<DockerCheck>;
  checkInternet(): Promise<CheckResult>;
  checkRegistry(registryUrl: string): Promise<RegistryCheck>;
  checkResources(requiredPorts: number[]): Promise<ResourceCheck>;
  runInstall(plan: BootstrapPlan): Promise<InstallOutcome>;
  checkHealth(plan: BootstrapPlan): Promise<HealthOutcome>;
}

/** Map the typed sub-results onto the wizard's generic {@link CheckResult}. */
export function dockerToCheck(d: DockerCheck): CheckResult {
  if (d.dockerAvailable && d.dockerComposeAvailable) {
    return { ok: true, severity: 'ok', detail: 'Docker engine + Compose v2 available.' };
  }
  const missing = [
    !d.dockerAvailable ? 'Docker engine' : null,
    !d.dockerComposeAvailable ? 'Docker Compose v2' : null,
  ].filter(Boolean);
  return { ok: false, severity: 'error', detail: `Missing: ${missing.join(', ')}.` };
}

export function registryToCheck(r: RegistryCheck): CheckResult {
  if (r.ok && r.signatureVerified) {
    return { ok: true, severity: 'ok', detail: r.detail ?? 'Registry reachable and signature verified.' };
  }
  return {
    ok: false,
    severity: 'error',
    detail: r.detail ?? (!r.ok ? 'Registry unreachable.' : 'Registry signature could not be verified.'),
  };
}

export function resourceToCheck(r: ResourceCheck): CheckResult {
  if (r.status === 'blocked') return { ok: false, severity: 'error', detail: r.detail ?? 'Resource preflight blocked.' };
  if (r.status === 'warning') return { ok: true, severity: 'warning', detail: r.detail ?? 'Resource preflight warnings.' };
  return { ok: true, severity: 'ok', detail: r.detail ?? 'Resources sufficient.' };
}

export function installToCheck(o: InstallOutcome): CheckResult {
  return o.ok
    ? { ok: true, severity: 'ok', detail: o.detail ?? `Installed at ${o.instanceDir ?? 'instance dir'}.` }
    : { ok: false, severity: 'error', detail: o.detail ?? 'Install failed.' };
}

export function healthToCheck(o: HealthOutcome): CheckResult {
  if (o.healthy && !o.degraded) return { ok: true, severity: 'ok', detail: o.detail ?? 'All services healthy.' };
  if (o.degraded) return { ok: true, severity: 'warning', detail: o.detail ?? 'Some services degraded.' };
  return { ok: false, severity: 'error', detail: o.detail ?? 'Health check failed.' };
}
