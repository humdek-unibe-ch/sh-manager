// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Real, side-effecting implementations of {@link ActionDeps}: Docker compose
 * runner, HTTP registry fetcher, image-digest resolution, health probing, and
 * host resource probing. The pure decision logic lives in @shm/core and the
 * CLI actions; this module is the boundary to the operating system + network.
 */
import { execFile, spawn } from 'node:child_process';
import { resolve4, resolve6 } from 'node:dns/promises';
import { createServer } from 'node:net';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LockServiceEntry, TrustedKeysFile } from '@shm/schemas';
import { validateTrustedKeys } from '@shm/schemas';
import { RealComposeRunner } from '@shm/docker';
import type { Fetcher, FetchResponse } from '@shm/registry';
import type { PreflightResourceFacts, ServiceProbeResult } from '@shm/core';
import type { ActionDeps } from './actions.js';

const execFileAsync = promisify(execFile);
const MANAGER_VERSION = '0.1.0';

class HttpFetcher implements Fetcher {
  async fetch(url: string): Promise<FetchResponse> {
    const res = await fetch(url);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, etag: res.headers.get('etag') ?? undefined };
  }
}

export async function loadTrustedKeys(file: string): Promise<TrustedKeysFile> {
  const data = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const v = validateTrustedKeys(data);
  if (!v.valid || !v.value) throw new Error(`Invalid trusted keys file ${file}: ${v.errors.join('; ')}`);
  return v.value;
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

async function composeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['compose', 'version', '--short']);
    return true;
  } catch {
    return false;
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function imageDigest(image: string): Promise<string> {
  try {
    await execFileAsync('docker', ['pull', image]);
  } catch {
    // Pull may fail offline; fall through to inspect of any local copy.
  }
  try {
    const { stdout } = await execFileAsync('docker', ['image', 'inspect', image, '--format', '{{index .RepoDigests 0}}']);
    const repoDigest = stdout.trim();
    const at = repoDigest.lastIndexOf('@');
    if (at >= 0) return repoDigest.slice(at + 1);
  } catch {
    // ignore
  }
  const { stdout } = await execFileAsync('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
  return stdout.trim();
}

export function realDeps(root: string, trustedKeys: TrustedKeysFile): ActionDeps {
  return {
    root,
    managerVersion: MANAGER_VERSION,
    trustedKeys,
    runner: new RealComposeRunner(),
    fetcher: new HttpFetcher(),
    resolveServiceDigests: async (images): Promise<{ mysql: LockServiceEntry; redis: LockServiceEntry; mercure: LockServiceEntry }> => ({
      mysql: { image: images.mysql, digest: await imageDigest(images.mysql) },
      redis: { image: images.redis, digest: await imageDigest(images.redis) },
      mercure: { image: images.mercure, digest: await imageDigest(images.mercure) },
    }),
    probeHealth: async (publicUrl, apiPrefix): Promise<ServiceProbeResult[]> => {
      const probes: ServiceProbeResult[] = [];
      // `apiPrefix` is the BFF-relative prefix (`/api`). The Next.js catch-all
      // proxy (`/api/[...path]`) RE-ADDS the Symfony API prefix (`/cms-api/v1`)
      // to whatever follows it, exactly like every browser call (`/api/auth/login`
      // -> upstream `/cms-api/v1/auth/login`). So the health probe must use the
      // BFF-relative `/health`; the BFF maps it to the backend's
      // `/cms-api/v1/health`. Appending `/cms-api/v1/health` here instead would
      // double the prefix (`/cms-api/v1/cms-api/v1/health`) and 404 the probe.
      const healthUrl = `${publicUrl}${apiPrefix}/health`;
      try {
        const res = await fetch(healthUrl);
        probes.push({ service: 'backend', ok: res.ok, detail: `HTTP ${res.status}` });
        probes.push({ service: 'frontend', ok: res.status < 500, detail: `HTTP ${res.status}` });
      } catch (err) {
        probes.push({ service: 'backend', ok: false, detail: err instanceof Error ? err.message : String(err) });
        probes.push({ service: 'frontend', ok: false, detail: 'unreachable' });
      }
      return probes;
    },
    resourceFacts: async (requiredPorts): Promise<PreflightResourceFacts> => {
      const fs = await statfs(root).catch(() => ({ bavail: 0, bsize: 0 }) as { bavail: number; bsize: number });
      const ports: { port: number; free: boolean }[] = [];
      for (const p of requiredPorts) ports.push({ port: p, free: await portFree(p) });
      return {
        requiredPortsFree: ports,
        diskBytesFree: Number(fs.bavail) * Number(fs.bsize),
        memoryBytesTotal: os.totalmem(),
        cpuCount: os.cpus().length,
        dockerAvailable: await dockerAvailable(),
        dockerComposeAvailable: await composeAvailable(),
      };
    },
    archiveVolume: async (volumeName, outFile): Promise<void> => {
      const dir = path.dirname(outFile);
      const base = path.basename(outFile);
      await execFileAsync('docker', [
        'run',
        '--rm',
        '-v',
        `${volumeName}:/data:ro`,
        '-v',
        `${dir}:/backup`,
        'busybox',
        'sh',
        '-lc',
        `tar czf /backup/${base} -C /data .`,
      ]);
    },
    removeVolumes: async (volumeNames): Promise<void> => {
      for (const name of volumeNames) {
        await execFileAsync('docker', ['volume', 'rm', name]);
      }
    },
    extractVolume: async (tgz, volumeName): Promise<void> => {
      const dir = path.dirname(tgz);
      const base = path.basename(tgz);
      // Mounting a named volume auto-creates it. Replace any existing contents
      // first so a same-instance restore does not leave stale files behind.
      await execFileAsync('docker', [
        'run',
        '--rm',
        '-v',
        `${volumeName}:/data`,
        '-v',
        `${dir}:/backup:ro`,
        'busybox',
        'sh',
        '-lc',
        `rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null; tar xzf /backup/${base} -C /data`,
      ]);
    },
    copyVolume: async (sourceVolume, destVolume): Promise<void> => {
      await execFileAsync('docker', [
        'run',
        '--rm',
        '-v',
        `${sourceVolume}:/from:ro`,
        '-v',
        `${destVolume}:/to`,
        'busybox',
        'sh',
        '-lc',
        'cp -a /from/. /to/',
      ]);
    },
    importDatabase: async (instanceDir, sqlFile): Promise<void> => {
      const sql = await readFile(sqlFile);
      await new Promise<void>((resolveImport, rejectImport) => {
        const child = spawn(
          'docker',
          ['compose', 'exec', '-T', 'mysql', 'sh', '-lc', 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'],
          { cwd: instanceDir, stdio: ['pipe', 'inherit', 'inherit'] },
        );
        child.on('error', rejectImport);
        child.on('close', (code) =>
          code === 0
            ? resolveImport()
            : rejectImport(new Error(`Database import exited with code ${code ?? 'null'}.`)),
        );
        child.stdin?.end(sql);
      });
    },
    resolveDns: async (host): Promise<{ a: string[]; aaaa: string[] }> => {
      const a = await resolve4(host).catch(() => [] as string[]);
      const aaaa = await resolve6(host).catch(() => [] as string[]);
      return { a, aaaa };
    },
    // Best-effort public IP via the official registry host's view would require a
    // network round-trip we deliberately avoid here; left undefined so the DNS
    // check confirms the domain resolves at all (catches typos) without a hard
    // server-IP comparison. Operators can wire SELFHELP_PUBLIC_IP if needed.
    ...(process.env.SELFHELP_PUBLIC_IP
      ? { serverPublicIp: async (): Promise<string | undefined> => process.env.SELFHELP_PUBLIC_IP }
      : {}),
  };
}
