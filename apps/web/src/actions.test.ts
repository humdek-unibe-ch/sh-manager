// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { provisionFailureDetail, type ProvisionStepLike } from './actions.js';

describe('provisionFailureDetail', () => {
  it('names the failed step and carries its detail (operators see WHY, not just "failed")', () => {
    const steps: ProvisionStepLike[] = [
      { name: 'wait_db', status: 'done' },
      { name: 'migrations', status: 'done' },
      { name: 'admin', status: 'failed', detail: 'app:create-admin-user exited 1: 500 from backend' },
    ];
    expect(provisionFailureDetail(steps)).toBe(
      'Provisioning failed at "admin": app:create-admin-user exited 1: 500 from backend',
    );
  });

  it('still names the step when it has no detail', () => {
    expect(provisionFailureDetail([{ name: 'health', status: 'failed' }])).toBe('Provisioning failed at "health".');
  });

  it('falls back to the generic message when no step is marked failed', () => {
    expect(provisionFailureDetail([{ name: 'wait_db', status: 'done' }])).toBe('Provisioning failed.');
  });
});
