// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared fixtures for the CLI action suites (`cli-*.test.ts`). These used to be
 * duplicated at the top of one giant `cli.test.ts`; they are factored out here
 * so every per-area suite builds the SAME offline {@link ActionDeps} (recording
 * compose runner + fixture registry fetcher + frozen clock) without copy/paste.
 *
 * Each suite keeps its own `root`/`trustedKeys`/`runner` lets + `beforeEach`
 * (a fresh temp root per test) and a thin `makeDeps()` that calls
 * {@link buildActionDeps}; that keeps the test bodies byte-identical to the
 * original monolith.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrustedKeysFile } from '@shm/schemas';
import type { RecordingComposeRunner } from '@shm/docker';
import type { Fetcher, FetchResponse } from '@shm/registry';
import type { ActionDeps } from '@shm/app-actions';

const examplesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'schemas',
  'examples',
);

/** Read a canonical example fixture (registry index, release docs, trusted keys). */
export const readExample = (n: string): Promise<string> => readFile(path.join(examplesDir, n), 'utf8');

/** Parse a `KEY=value` secrets.env into a map (values may contain `=`). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

/** A registry fetcher that answers from in-memory fixture bodies keyed by URL suffix. */
export class FixtureFetcher implements Fetcher {
  constructor(private readonly map: Record<string, string>) {}
  async fetch(url: string): Promise<FetchResponse> {
    for (const [suffix, body] of Object.entries(this.map)) if (url.endsWith(suffix)) return { ok: true, status: 200, text: body };
    return { ok: false, status: 404, text: '' };
  }
}

/** The mutable per-test fixtures every CLI suite owns (fresh in its `beforeEach`). */
export interface CliCtx {
  root: string;
  trustedKeys: TrustedKeysFile;
  runner: RecordingComposeRunner;
}

/**
 * Build the offline {@link ActionDeps} the CLI suites run against: the suite's
 * recording runner, a fixture registry fetcher, stubbed digest/health/resource
 * probes and a frozen clock. Identical to the old inline `makeDeps()`.
 */
export async function buildActionDeps(ctx: CliCtx): Promise<ActionDeps> {
  const fetcher = new FixtureFetcher({
    'registry.json': await readExample('registry-index.json'),
    'selfhelp-core-0.1.0.json': await readExample('core-release.json'),
    'selfhelp-frontend-0.1.0.json': await readExample('frontend-release.json'),
  });
  const digest = `sha256:${'a'.repeat(64)}`;
  return {
    root: ctx.root,
    managerVersion: '0.1.0',
    trustedKeys: ctx.trustedKeys,
    runner: ctx.runner,
    fetcher,
    resolveServiceDigests: async (images) => ({
      mysql: { image: images.mysql, digest },
      redis: { image: images.redis, digest },
      mercure: { image: images.mercure, digest },
    }),
    probeHealth: async () => [
      { service: 'backend', ok: true, detail: 'HTTP 200' },
      { service: 'frontend', ok: true, detail: 'HTTP 200' },
    ],
    resourceFacts: async (ports) => ({
      requiredPortsFree: ports.map((p) => ({ port: p, free: true })),
      diskBytesFree: 100 * 1024 * 1024 * 1024,
      memoryBytesTotal: 16 * 1024 * 1024 * 1024,
      cpuCount: 8,
      dockerAvailable: true,
      dockerComposeAvailable: true,
    }),
    now: () => '2026-06-05T10:00:00.000Z',
  };
}
