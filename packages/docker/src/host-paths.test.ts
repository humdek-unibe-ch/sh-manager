// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { discoverEngineRoot, mappingFromMounts, toEnginePath } from './host-paths.js';

const ROOT = '/opt/selfhelp';
// What Docker Desktop (WSL2 backend) reports as the bind source when the user
// mounts `D:\selfhelp` — the engine-side VM path users previously had to type.
const DESKTOP_SOURCE = '/run/desktop/mnt/host/d/selfhelp';

function desktopMountsJson(source = DESKTOP_SOURCE, destination = ROOT): string {
  return JSON.stringify([
    { Type: 'bind', Source: '/run/desktop/docker.sock', Destination: '/var/run/docker.sock' },
    { Type: 'bind', Source: source, Destination: destination, Mode: '', RW: true },
  ]);
}

describe('toEnginePath', () => {
  const mapping = { containerRoot: ROOT, engineRoot: DESKTOP_SOURCE };

  it('rewrites the root and everything under it to the engine view', () => {
    expect(toEnginePath('/opt/selfhelp', mapping)).toBe(DESKTOP_SOURCE);
    expect(toEnginePath('/opt/selfhelp/instances/demo1', mapping)).toBe(`${DESKTOP_SOURCE}/instances/demo1`);
    expect(toEnginePath('/opt/selfhelp/instances/demo1/backups', mapping)).toBe(`${DESKTOP_SOURCE}/instances/demo1/backups`);
  });

  it('never rewrites a sibling path that merely shares the prefix', () => {
    expect(toEnginePath('/opt/selfhelp2/instances/demo1', mapping)).toBe('/opt/selfhelp2/instances/demo1');
    expect(toEnginePath('/etc/passwd', mapping)).toBe('/etc/passwd');
  });

  it('is the identity without a mapping (same-path Linux production mount)', () => {
    expect(toEnginePath('/opt/selfhelp/instances/demo1', undefined)).toBe('/opt/selfhelp/instances/demo1');
  });

  it('normalizes Windows-style separators before matching and in the output', () => {
    expect(toEnginePath('/opt/selfhelp\\instances\\demo1', mapping)).toBe(`${DESKTOP_SOURCE}/instances/demo1`);
  });
});

describe('mappingFromMounts', () => {
  it('finds the engine-side source of the state root among the container mounts', () => {
    expect(mappingFromMounts(ROOT, desktopMountsJson())).toEqual({
      containerRoot: ROOT,
      engineRoot: DESKTOP_SOURCE,
    });
  });

  it('returns no mapping for a same-path mount (Linux production)', () => {
    expect(mappingFromMounts(ROOT, desktopMountsJson(ROOT))).toBeUndefined();
  });

  it('returns no mapping when the root is not mounted at all or the JSON is junk', () => {
    expect(mappingFromMounts(ROOT, JSON.stringify([{ Source: '/x', Destination: '/y' }]))).toBeUndefined();
    expect(mappingFromMounts(ROOT, 'not json')).toBeUndefined();
    expect(mappingFromMounts(ROOT, '{}')).toBeUndefined();
  });
});

describe('discoverEngineRoot', () => {
  it('discovers the Docker Desktop mapping by inspecting its own container', async () => {
    const mapping = await discoverEngineRoot({
      root: ROOT,
      env: {},
      isContainerized: () => true,
      inspectSelfMounts: async () => desktopMountsJson(),
    });
    expect(mapping).toEqual({ containerRoot: ROOT, engineRoot: DESKTOP_SOURCE });
  });

  it('returns no mapping outside a container (manager running from source)', async () => {
    const mapping = await discoverEngineRoot({
      root: ROOT,
      env: {},
      isContainerized: () => false,
      inspectSelfMounts: async () => desktopMountsJson(),
    });
    expect(mapping).toBeUndefined();
  });

  it('honours the SELFHELP_ENGINE_ROOT override and its "off" switch', async () => {
    const inspect = async (): Promise<string> => {
      throw new Error('must not be called when the override is set');
    };
    expect(
      await discoverEngineRoot({
        root: ROOT,
        env: { SELFHELP_ENGINE_ROOT: '/srv/selfhelp' },
        isContainerized: () => true,
        inspectSelfMounts: inspect,
      }),
    ).toEqual({ containerRoot: ROOT, engineRoot: '/srv/selfhelp' });
    expect(
      await discoverEngineRoot({
        root: ROOT,
        env: { SELFHELP_ENGINE_ROOT: 'off' },
        isContainerized: () => true,
        inspectSelfMounts: inspect,
      }),
    ).toBeUndefined();
    expect(
      await discoverEngineRoot({
        root: ROOT,
        env: { SELFHELP_ENGINE_ROOT: ROOT },
        isContainerized: () => true,
        inspectSelfMounts: inspect,
      }),
    ).toBeUndefined();
  });

  it('degrades to no mapping when self-inspection fails (hostname overridden, etc.)', async () => {
    const mapping = await discoverEngineRoot({
      root: ROOT,
      env: {},
      isContainerized: () => true,
      inspectSelfMounts: async () => {
        throw new Error('no such container');
      },
    });
    expect(mapping).toBeUndefined();
  });
});
