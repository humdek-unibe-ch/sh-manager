// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type {
  CoreRelease,
  FrontendRelease,
  SchedulerRelease,
  SecurityAdvisory,
  WorkerRelease,
} from '@shm/schemas';
import {
  pickFrontendForCore,
  pickSchedulerForCore,
  pickWorkerForCore,
  resolveCoreTarget,
  resolveFrontendUpdate,
} from './core.js';

function core(version: string, minFrom = '1.3.0', blocked = false): CoreRelease {
  return {
    kind: 'selfhelp-core-release',
    id: 'selfhelp-core',
    version,
    channel: 'stable',
    releasedAt: '2026-06-05T10:00:00Z',
    minimumDirectUpgradeFrom: minFrom,
    pluginApiVersion: '2.2',
    backend: { image: 'b', digest: 'sha256:b' },
    worker: { image: 'w', digest: 'sha256:w' },
    scheduler: { image: 's', digest: 'sha256:s' },
    frontendCompatibility: { requiredFrontendRange: `>=${version} <${semverNextMinor(version)}` },
    database: { migrationRange: 'a-b', destructive: false, requiresBackup: true, manualConfirmationRequired: false },
    security: { signature: 's', keyId: 'humdek-2026-01' },
    blocked,
  };
}

function semverNextMinor(v: string): string {
  const [maj, min] = v.split('.').map(Number);
  return `${maj}.${(min ?? 0) + 1}.0`;
}

function frontend(version: string, requiredCoreRange: string): FrontendRelease {
  return {
    kind: 'selfhelp-frontend-release',
    id: 'selfhelp-frontend',
    version,
    channel: 'stable',
    image: 'f',
    digest: 'sha256:f',
    backendCompatibility: { requiredCoreRange, requiredApiVersion: 'v1' },
    security: { signature: 's', keyId: 'humdek-2026-01' },
  };
}

describe('resolveCoreTarget', () => {
  const available = [core('1.4.2'), core('1.5.0'), core('1.6.0')];

  it('selects the newest directly-upgradable stable release for "latest"', () => {
    const r = resolveCoreTarget({ currentVersion: '1.4.0', available });
    expect(r.status).toBe('ok');
    expect(r.selected?.version).toBe('1.6.0');
  });

  it('reports up_to_date when current is the newest', () => {
    const r = resolveCoreTarget({ currentVersion: '1.6.0', available });
    expect(r.status).toBe('up_to_date');
  });

  it('selects a specific target version when directly upgradable', () => {
    const r = resolveCoreTarget({ currentVersion: '1.4.0', available, target: '1.5.0' });
    expect(r.selected?.version).toBe('1.5.0');
  });

  it('blocks a specific target that is not directly upgradable', () => {
    const r = resolveCoreTarget({ currentVersion: '1.0.0', available, target: '1.6.0' });
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/minimum direct upgrade from/);
  });

  it('blocks a version affected by a blocking advisory', () => {
    const advisories: SecurityAdvisory[] = [
      {
        id: 'SHSA-2026-0009',
        severity: 'critical',
        affected: [{ kind: 'core', id: 'selfhelp-core', versions: '1.6.0' }],
        fixed: [{ kind: 'core', id: 'selfhelp-core', version: '1.6.1' }],
        recommendedAction: 'Avoid 1.6.0.',
        blocked: true,
      },
    ];
    const r = resolveCoreTarget({ currentVersion: '1.4.0', available, target: '1.6.0', advisories });
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/security advisory/);
  });
});

describe('pickFrontendForCore', () => {
  it('selects a frontend in range for the core', () => {
    const c = core('1.5.0');
    const f = pickFrontendForCore(c, [
      frontend('1.4.9', '>=1.4.0 <1.5.0'),
      frontend('1.5.3', '>=1.5.0 <1.6.0'),
    ]);
    expect(f?.version).toBe('1.5.3');
  });

  it('returns null when no frontend matches', () => {
    const c = core('1.5.0');
    const f = pickFrontendForCore(c, [frontend('1.4.9', '>=1.4.0 <1.5.0')]);
    expect(f).toBeNull();
  });
});

describe('resolveFrontendUpdate', () => {
  const available = [
    frontend('0.1.4', '>=0.1.0 <0.2.0'),
    frontend('0.1.5', '>=0.1.0 <0.2.0'),
    frontend('0.1.7', '>=0.1.0 <0.2.0'),
  ];

  it('selects the newest compatible frontend strictly newer than the installed one', () => {
    const r = resolveFrontendUpdate({ currentFrontendVersion: '0.1.5', coreVersion: '0.1.4', available });
    expect(r.status).toBe('ok');
    expect(r.selected?.version).toBe('0.1.7');
  });

  it('reports up_to_date when the installed frontend is already the newest', () => {
    const r = resolveFrontendUpdate({ currentFrontendVersion: '0.1.7', coreVersion: '0.1.4', available });
    expect(r.status).toBe('up_to_date');
    expect(r.selected).toBeNull();
  });

  it('selects a specific newer target version', () => {
    const r = resolveFrontendUpdate({ currentFrontendVersion: '0.1.4', coreVersion: '0.1.4', available, target: '0.1.5' });
    expect(r.status).toBe('ok');
    expect(r.selected?.version).toBe('0.1.5');
  });

  it('blocks a downgrade to an older frontend', () => {
    const r = resolveFrontendUpdate({ currentFrontendVersion: '0.1.7', coreVersion: '0.1.4', available, target: '0.1.5' });
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/downgrade/i);
  });

  it('blocks a specific target that is not in the channel', () => {
    const r = resolveFrontendUpdate({ currentFrontendVersion: '0.1.4', coreVersion: '0.1.4', available, target: '9.9.9' });
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/not available/i);
  });

  it('ignores frontends incompatible with the running core', () => {
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.5',
      coreVersion: '0.1.4',
      available: [frontend('0.2.0', '>=0.2.0 <0.3.0')],
    });
    expect(r.status).toBe('up_to_date');
  });

  it('enforces the running core required frontend range when the core release is known', () => {
    const runningCore = core('0.1.4');
    runningCore.frontendCompatibility = { requiredFrontendRange: '>=0.1.0 <0.1.6' };
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.5',
      coreVersion: '0.1.4',
      currentCore: runningCore,
      available,
    });
    // 0.1.7 is forbidden by the running core; nothing newer is acceptable.
    expect(r.status).toBe('up_to_date');
  });

  it('skips a frontend blocked by a security advisory', () => {
    const advisories: SecurityAdvisory[] = [
      {
        id: 'SHSA-2026-0010',
        severity: 'high',
        affected: [{ kind: 'frontend', id: 'selfhelp-frontend', versions: '0.1.7' }],
        fixed: [{ kind: 'frontend', id: 'selfhelp-frontend', version: '0.1.8' }],
        recommendedAction: 'Avoid frontend 0.1.7.',
        blocked: true,
      },
    ];
    const r = resolveFrontendUpdate({ currentFrontendVersion: '0.1.5', coreVersion: '0.1.4', available, advisories });
    expect(r.status).toBe('up_to_date');
  });
});

describe('resolveFrontendUpdate – running-core requiredFrontendRange enforcement', () => {
  // The bug scenario: core 0.1.11 forbids frontends >= 0.1.18, frontend 0.1.19
  // is published targeting a wide core range, and 0.1.17 is the newest the core
  // still accepts. The core's range must gate the update from EITHER the live
  // registry release OR the value recorded in the instance lock, and must never
  // be silently dropped.
  const CORE_RANGE = '>=0.1.0 <0.1.18';
  const candidates = [
    frontend('0.1.17', '>=0.1.0 <0.2.0'),
    frontend('0.1.19', '>=0.1.0 <0.2.0'),
  ];
  const runningCore011 = (): CoreRelease => {
    const c = core('0.1.11');
    c.frontendCompatibility = { requiredFrontendRange: CORE_RANGE };
    return c;
  };

  it('blocks frontend 0.1.19 (specific target) from the LIVE registry core range', () => {
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.17',
      coreVersion: '0.1.11',
      currentCore: runningCore011(),
      requireCoreFrontendRange: true,
      available: candidates,
      target: '0.1.19',
    });
    expect(r.status).toBe('blocked');
    expect(r.selected).toBeNull();
    expect(r.reasons.join(' ')).toMatch(/not accepted by the running SelfHelp core 0\.1\.11/i);
    expect(r.reasons.join(' ')).toContain(CORE_RANGE);
  });

  it('blocks frontend 0.1.19 from the LOCK range even when the core left the registry (currentCore null)', () => {
    // This is the exact bypass the fix closes: the core release is gone from the
    // registry, but the range persisted in the lock still forbids 0.1.19.
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.17',
      coreVersion: '0.1.11',
      currentCore: null,
      currentCoreRequiredFrontendRange: CORE_RANGE,
      requireCoreFrontendRange: true,
      available: candidates,
      target: '0.1.19',
    });
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/required frontend range/i);
    expect(r.reasons.join(' ')).toContain(CORE_RANGE);
  });

  it("'latest' selects the newest frontend the lock range allows and skips the forbidden newer one", () => {
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.16',
      coreVersion: '0.1.11',
      currentCoreRequiredFrontendRange: CORE_RANGE,
      requireCoreFrontendRange: true,
      available: candidates,
    });
    expect(r.status).toBe('ok');
    expect(r.selected?.version).toBe('0.1.17');
  });

  it('succeeds when both ranges accept the target using ONLY the lock range (no registry core)', () => {
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.16',
      coreVersion: '0.1.11',
      currentCore: null,
      currentCoreRequiredFrontendRange: '>=0.1.0 <0.2.0',
      requireCoreFrontendRange: true,
      available: candidates,
      target: '0.1.19',
    });
    expect(r.status).toBe('ok');
    expect(r.selected?.version).toBe('0.1.19');
  });

  it('fails closed (blocked) for "latest" when the required range cannot be determined', () => {
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.17',
      coreVersion: '0.1.11',
      currentCore: null,
      currentCoreRequiredFrontendRange: null,
      requireCoreFrontendRange: true,
      available: candidates,
    });
    expect(r.status).toBe('blocked');
    expect(r.selected).toBeNull();
    expect(r.reasons.join(' ')).toMatch(/no longer in the registry/i);
    expect(r.reasons.join(' ')).toMatch(/Update the core first/i);
  });

  it('fails closed (blocked) for a specific target when the required range cannot be determined', () => {
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.17',
      coreVersion: '0.1.11',
      requireCoreFrontendRange: true,
      available: candidates,
      target: '0.1.19',
    });
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/no longer in the registry/i);
  });

  it('prefers the LIVE registry core range over the lock range when both are present', () => {
    // The lock claims a wider range, but the authoritative live release forbids
    // 0.1.19; the live range must win so a stale/looser lock cannot loosen the gate.
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.17',
      coreVersion: '0.1.11',
      currentCore: runningCore011(),
      currentCoreRequiredFrontendRange: '>=0.1.0 <0.2.0',
      requireCoreFrontendRange: true,
      available: candidates,
      target: '0.1.19',
    });
    expect(r.status).toBe('blocked');
  });

  it('stays permissive when the constraint is not required (pure resolver default, no regression)', () => {
    // Without requireCoreFrontendRange and with no core info, the resolver keeps
    // its original permissive behaviour (the app-actions caller opts in to the
    // fail-closed enforcement).
    const r = resolveFrontendUpdate({
      currentFrontendVersion: '0.1.16',
      coreVersion: '0.1.11',
      available: candidates,
    });
    expect(r.status).toBe('ok');
    expect(r.selected?.version).toBe('0.1.19');
  });
});

function scheduler(version: string, requiredCoreRange: string, blocked = false): SchedulerRelease {
  return {
    kind: 'selfhelp-scheduler-release',
    id: 'selfhelp-scheduler',
    version,
    channel: 'stable',
    image: 's',
    digest: 'sha256:s',
    backendCompatibility: { requiredCoreRange },
    security: { signature: 's', keyId: 'humdek-2026-01' },
    blocked,
  };
}

function worker(version: string, requiredCoreRange: string, blocked = false): WorkerRelease {
  return {
    kind: 'selfhelp-worker-release',
    id: 'selfhelp-worker',
    version,
    channel: 'stable',
    image: 'w',
    digest: 'sha256:w',
    backendCompatibility: { requiredCoreRange },
    security: { signature: 's', keyId: 'humdek-2026-01' },
    blocked,
  };
}

describe('pickSchedulerForCore / pickWorkerForCore', () => {
  it('selects the newest scheduler whose requiredCoreRange the core satisfies', () => {
    const c = core('1.5.0');
    const s = pickSchedulerForCore(c, [
      scheduler('1.4.9', '>=1.4.0 <1.5.0'),
      scheduler('1.5.1', '>=1.5.0 <1.6.0'),
      scheduler('1.5.4', '>=1.5.0 <1.6.0'),
    ]);
    expect(s?.version).toBe('1.5.4');
  });

  it('selects the newest worker whose requiredCoreRange the core satisfies', () => {
    const c = core('1.5.0');
    const w = pickWorkerForCore(c, [worker('1.5.0', '>=1.5.0 <1.6.0'), worker('1.4.0', '>=1.4.0 <1.5.0')]);
    expect(w?.version).toBe('1.5.0');
  });

  it('skips blocked releases and returns null when none match', () => {
    const c = core('1.5.0');
    expect(pickSchedulerForCore(c, [scheduler('1.5.9', '>=1.5.0 <1.6.0', true)])).toBeNull();
    expect(pickWorkerForCore(c, [worker('1.4.9', '>=1.4.0 <1.5.0')])).toBeNull();
  });
});
