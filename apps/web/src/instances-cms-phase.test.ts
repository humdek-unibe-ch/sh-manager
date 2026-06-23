// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { cmsUpdatePhaseStep } from './instances.js';

describe('cmsUpdatePhaseStep', () => {
  it('maps a core update lifecycle onto the instance_update checklist rows', () => {
    expect(cmsUpdatePhaseStep('core', 'accepted')).toBe('plan');
    expect(cmsUpdatePhaseStep('core', 'preflight_running')).toBe('plan');
    expect(cmsUpdatePhaseStep('core', 'backup_running')).toBe('backup');
    expect(cmsUpdatePhaseStep('core', 'update_running')).toBe('pull');
    expect(cmsUpdatePhaseStep('core', 'migration_running')).toBe('migrations');
    expect(cmsUpdatePhaseStep('core', 'health_check_running')).toBe('health');
  });

  it('skips the backup row for a frontend-only update (it takes no backup)', () => {
    expect(cmsUpdatePhaseStep('frontend', 'preflight_running')).toBe('plan');
    expect(cmsUpdatePhaseStep('frontend', 'backup_running')).toBeNull();
    expect(cmsUpdatePhaseStep('frontend', 'health_check_running')).toBe('health');
  });

  it('skips backup AND migrations for a mobile-preview swap (stateless, no DB work)', () => {
    expect(cmsUpdatePhaseStep('mobile-preview', 'preflight_running')).toBe('plan');
    expect(cmsUpdatePhaseStep('mobile-preview', 'backup_running')).toBeNull();
    expect(cmsUpdatePhaseStep('mobile-preview', 'update_running')).toBe('pull');
    expect(cmsUpdatePhaseStep('mobile-preview', 'migration_running')).toBeNull();
    expect(cmsUpdatePhaseStep('mobile-preview', 'health_check_running')).toBe('health');
  });

  it('returns null for terminal/unknown statuses (reflected by the op result)', () => {
    expect(cmsUpdatePhaseStep('core', 'succeeded')).toBeNull();
    expect(cmsUpdatePhaseStep('core', 'failed')).toBeNull();
    expect(cmsUpdatePhaseStep(undefined, 'whatever')).toBeNull();
  });
});
