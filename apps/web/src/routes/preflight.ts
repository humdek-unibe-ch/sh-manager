// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Stateless preflight route: the same checks the old bootstrap wizard ran
 * (Docker, internet, registry, host resources), executed on demand for the
 * create-instance wizard. Production mode also verifies ports 80/443 are usable
 * (the shared proxy needs them).
 */
import type { ServerResponse } from 'node:http';
import { dockerToCheck, registryToCheck, resourceToCheck, type CheckResult } from '../actions.js';
import { sendJson } from '../http/respond.js';
import type { RequestContext, ServerCtx } from './context.js';

function toErrorCheck(err: unknown): CheckResult {
  return { ok: false, severity: 'error', detail: err instanceof Error ? err.message : String(err) };
}

export async function handlePreflight(srv: ServerCtx, ctx: RequestContext, res: ServerResponse): Promise<void> {
  const body = (ctx.body ?? {}) as { mode?: string; registryUrl?: string };
  const registryUrl =
    body.registryUrl && /^https?:\/\//.test(body.registryUrl) ? body.registryUrl : srv.defaultRegistryUrl;
  const ports = body.mode === 'production' ? [80, 443] : [];
  const [docker, internet, registry, resources] = await Promise.all([
    srv.options.actions.checkDocker().then(dockerToCheck, toErrorCheck),
    srv.options.actions.checkInternet().catch(toErrorCheck),
    srv.options.actions.checkRegistry(registryUrl).then(registryToCheck, toErrorCheck),
    srv.options.actions.checkResources(ports).then(resourceToCheck, toErrorCheck),
  ]);
  sendJson(res, 200, { docker, internet, registry, resources, registryUrl });
}
