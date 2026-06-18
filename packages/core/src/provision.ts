// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Post-`up` instance provisioning.
 *
 * {@link installInstance} writes every artifact and (optionally) brings the
 * stack up, but a fresh instance is not usable until migrations have run, an
 * admin exists, the selected plugins are installed, and health is green. This
 * module is the ordered, fail-fast orchestrator for that sequence.
 *
 * All side effects are injected ({@link ProvisionDeps}) so the ordering, skip,
 * and failure semantics are unit-testable offline; the real Docker-exec wiring
 * lives in the CLI actions layer. Unlike an update there is nothing to roll back
 * to on a brand-new install, so a failed step stops the sequence and is reported
 * — the operator removes and retries (volumes are still empty).
 */
import { type HealthReport } from './health.js';

export type ProvisionStepName =
  | 'wait_db'
  | 'migrations'
  | 'seed'
  | 'admin'
  | 'plugins'
  | 'cache_warm'
  | 'health';

export type ProvisionStepStatus = 'done' | 'failed' | 'skipped';

export interface ProvisionStepResult {
  name: ProvisionStepName;
  status: ProvisionStepStatus;
  detail?: string;
}

export interface ProvisionReport {
  instanceId: string;
  version: string;
  /** True only when every required step ran and health is not `unhealthy`. */
  ok: boolean;
  health: HealthReport | null;
  steps: ProvisionStepResult[];
}

export interface ProvisionDeps {
  /** Block until the DB accepts a trivial query; throw if it never becomes ready. */
  waitForDatabase: () => Promise<void>;
  /** Run backend Doctrine migrations to head. */
  runMigrations: () => Promise<void>;
  /** Optional: seed API routes / permissions / lookups when the install needs it. */
  seed?: () => Promise<void>;
  /** Optional: create the first CMS admin. `created=false` means it already existed. */
  createAdmin?: () => Promise<{ created: boolean; detail?: string }>;
  /** Optional: install selected plugins (and their migrations). */
  installPlugins?: () => Promise<{ installed: string[]; detail?: string }>;
  /** Optional: warm caches so the first request is not cold. */
  warmCaches?: () => Promise<void>;
  /** Final readiness gate. */
  checkHealth: () => Promise<HealthReport>;
  /** Coarse progress callback. */
  onPhase?: (name: ProvisionStepName, detail?: string) => void | Promise<void>;
}

export interface ProvisionInput {
  instanceId: string;
  version: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs a single step, recording its result. A returned string becomes the
 * step detail; a thrown error marks it failed. Returns whether it succeeded so
 * the caller can stop the sequence (fail-fast).
 */
async function runStep(
  steps: ProvisionStepResult[],
  name: ProvisionStepName,
  // `fn` may resolve to a detail string OR nothing; several deps are
  // `() => Promise<void>` (waitForDatabase/runMigrations/warmCaches), so
  // narrowing to `string | undefined` would reject them. The void-in-union is
  // intentional for this step-callback contract.
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  fn: () => Promise<string | void>,
  onPhase: ProvisionDeps['onPhase'],
): Promise<boolean> {
  try {
    await onPhase?.(name);
    const detail = await fn();
    steps.push(detail ? { name, status: 'done', detail } : { name, status: 'done' });
    return true;
  } catch (err) {
    steps.push({ name, status: 'failed', detail: errMessage(err) });
    return false;
  }
}

/**
 * Provisions a freshly-installed, brought-up instance: wait for DB → migrate →
 * (seed) → (admin) → (plugins) → (cache warm) → health. Optional steps are
 * skipped when their dependency is not supplied. The sequence stops at the first
 * failure and the report reflects exactly what ran.
 */
export async function provisionInstance(input: ProvisionInput, deps: ProvisionDeps): Promise<ProvisionReport> {
  const steps: ProvisionStepResult[] = [];
  const report: ProvisionReport = {
    instanceId: input.instanceId,
    version: input.version,
    ok: false,
    health: null,
    steps,
  };

  if (!(await runStep(steps, 'wait_db', deps.waitForDatabase, deps.onPhase))) return report;
  if (!(await runStep(steps, 'migrations', deps.runMigrations, deps.onPhase))) return report;

  if (deps.seed) {
    if (!(await runStep(steps, 'seed', deps.seed, deps.onPhase))) return report;
  } else {
    steps.push({ name: 'seed', status: 'skipped' });
  }

  if (deps.createAdmin) {
    const ok = await runStep(
      steps,
      'admin',
      async () => {
        const r = await deps.createAdmin!();
        return r.detail ?? (r.created ? 'created' : 'already exists');
      },
      deps.onPhase,
    );
    if (!ok) return report;
  } else {
    steps.push({ name: 'admin', status: 'skipped' });
  }

  if (deps.installPlugins) {
    const ok = await runStep(
      steps,
      'plugins',
      async () => {
        const r = await deps.installPlugins!();
        return r.installed.length > 0 ? r.installed.join(', ') : (r.detail ?? 'none');
      },
      deps.onPhase,
    );
    if (!ok) return report;
  } else {
    steps.push({ name: 'plugins', status: 'skipped' });
  }

  if (deps.warmCaches) {
    if (!(await runStep(steps, 'cache_warm', deps.warmCaches, deps.onPhase))) return report;
  } else {
    steps.push({ name: 'cache_warm', status: 'skipped' });
  }

  const healthOk = await runStep(
    steps,
    'health',
    async () => {
      const health = await deps.checkHealth();
      report.health = health;
      // A required service down (`unhealthy`) is a hard failure; `degraded`
      // (an optional service still settling) is surfaced but not fatal.
      if (health.overall === 'unhealthy') throw new Error(`overall=${health.overall}`);
      return `overall=${health.overall}`;
    },
    deps.onPhase,
  );
  if (!healthOk) return report;

  report.ok = true;
  return report;
}
