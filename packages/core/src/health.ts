// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Health aggregation. Probes (HTTP/exec) are the side-effecting boundary; this
 * module turns probe results into an overall instance health verdict.
 */
export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export const CORE_SERVICES = [
  'backend',
  'frontend',
  'scheduler',
  'worker',
  'mysql',
  'redis',
  'mercure',
] as const;
export type CoreService = (typeof CORE_SERVICES)[number];

/** Services whose failure makes the instance unusable (vs. degraded). */
export const REQUIRED_SERVICES: ReadonlySet<string> = new Set<CoreService>([
  'backend',
  'frontend',
  'mysql',
  'redis',
]);

export interface ServiceProbeResult {
  service: string;
  ok: boolean;
  detail?: string;
  /** Overrides the default required/optional classification. */
  required?: boolean;
}

export interface ServiceHealth {
  service: string;
  state: HealthState;
  required: boolean;
  detail?: string;
}

export interface HealthReport {
  instanceId: string;
  overall: HealthState;
  services: ServiceHealth[];
  checkedAt: string;
}

export function evaluateHealth(
  instanceId: string,
  probes: ServiceProbeResult[],
  now: () => string = () => new Date().toISOString(),
): HealthReport {
  const services: ServiceHealth[] = probes.map((p) => {
    const required = p.required ?? REQUIRED_SERVICES.has(p.service);
    return {
      service: p.service,
      state: p.ok ? 'healthy' : required ? 'unhealthy' : 'degraded',
      required,
      detail: p.detail,
    };
  });

  let overall: HealthState;
  if (services.length === 0) {
    overall = 'unknown';
  } else if (services.some((s) => s.required && s.state === 'unhealthy')) {
    overall = 'unhealthy';
  } else if (services.some((s) => s.state !== 'healthy')) {
    overall = 'degraded';
  } else {
    overall = 'healthy';
  }

  return { instanceId, overall, services, checkedAt: now() };
}

export function isHealthy(report: HealthReport): boolean {
  return report.overall === 'healthy';
}
