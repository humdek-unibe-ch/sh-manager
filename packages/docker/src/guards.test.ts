// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  assertComposeSafe,
  assertSafeComposeArgs,
  findDockerSocketMounts,
  findProxyNetworkViolations,
} from './guards.js';

describe('findDockerSocketMounts', () => {
  it('flags a service mounting the Docker socket', () => {
    const doc = {
      services: {
        backend: { volumes: ['/var/run/docker.sock:/var/run/docker.sock'] },
      },
    };
    const v = findDockerSocketMounts(doc);
    expect(v).toHaveLength(1);
    expect(() => assertComposeSafe(doc)).toThrow(/docker.sock/);
  });
});

describe('findProxyNetworkViolations', () => {
  it('flags a non-frontend service on the proxy network', () => {
    const doc = {
      services: {
        frontend: { networks: ['instance', 'selfhelp_proxy'] },
        backend: { networks: ['instance', 'selfhelp_proxy'] },
      },
    };
    const v = findProxyNetworkViolations(doc);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toMatch(/backend/);
  });
});

describe('assertSafeComposeArgs', () => {
  it('refuses destructive volume-deleting down commands', () => {
    expect(() => assertSafeComposeArgs(['down', '-v'])).toThrow(/persistent volumes/);
    expect(() => assertSafeComposeArgs(['down', '--volumes'])).toThrow();
    expect(() => assertSafeComposeArgs(['down', '--rmi'])).toThrow();
  });

  it('allows a normal down and up', () => {
    expect(() => assertSafeComposeArgs(['down'])).not.toThrow();
    expect(() => assertSafeComposeArgs(['up', '-d'])).not.toThrow();
  });
});
