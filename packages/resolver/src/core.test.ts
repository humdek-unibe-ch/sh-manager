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
