// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Instance lifecycle + server-status routes for the manager BFF. Reads answer
 * directly; every mutation runs through the operation journal + audit log +
 * per-instance lock and answers `202 { operationId }`. Server-authoritative
 * validation (create/clone/address/schedule/mailer/env) is re-applied here so
 * the API can never be driven past the rules the wizard enforces field-by-field.
 */
import type { ServerResponse } from 'node:http';
import type { BackupSchedulePolicy } from '@shm/schemas';
import { validateSchedulePolicy } from '@shm/backup';
import { InstanceLockedError, type OperationRunner } from '../jobs.js';
import {
  MAILER_DSN_RE,
  validateAddressChange,
  validateCloneInstance,
  validateCreateInstance,
} from '../instance-validation.js';
import { LOG_SERVICES } from '../instances.js';
import type {
  CloneInstanceRequest,
  CreateInstanceRequest,
  FrontendUpdateInstanceRequest,
  LogService,
  RemoveInstanceRequest,
  SafeModeRequest,
  SetAddressRequest,
  SetEnvRequest,
  SetMailerRequest,
  SetNameRequest,
  UpdateInstanceRequest,
} from '../instances.js';
import { HttpError, sendJson } from '../http/respond.js';
import { handlePreflight } from './preflight.js';
import type { RequestContext, ServerCtx } from './context.js';

// Lowercase only — matches the create-form/wizard validation and the CLI's
// on-disk layout (compose project names + paths are lowercase).
const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function requireInstanceId(raw: string | undefined): string {
  if (!raw || !INSTANCE_ID_RE.test(raw)) throw new HttpError(400, 'Invalid instance id.');
  return raw;
}

/**
 * Instance lifecycle APIs. Reads answer directly; mutations run through the
 * operation journal + audit + per-instance lock and answer `202 { operationId }`.
 * Returns `false` when no instance route matched so the caller can continue
 * dispatching.
 */
export async function routeInstanceManagement(
  srv: ServerCtx,
  ctx: RequestContext,
  res: ServerResponse,
): Promise<boolean> {
  const im = srv.options.instanceManagement;
  if (!im) return false;
  const path = ctx.url.pathname;
  const operator = ctx.session?.email ?? 'unknown';

  async function start(
    kind: Parameters<OperationRunner['start']>[0]['kind'],
    instanceId: string | null,
    body: Parameters<OperationRunner['start']>[1],
  ): Promise<void> {
    try {
      const { operationId } = await im!.runner.start({ kind, instanceId, operator, sourceIp: ctx.sourceIp }, body);
      sendJson(res, 202, { operationId });
    } catch (err) {
      if (err instanceof InstanceLockedError) throw new HttpError(409, err.message);
      throw err;
    }
  }

  if (path === '/api/server/status' && ctx.method === 'GET') {
    sendJson(res, 200, await im.instances.serverStatus());
    return true;
  }
  if (path === '/api/server/proxy-logs' && ctx.method === 'GET') {
    const tail = ctx.url.searchParams.has('tail') ? Number(ctx.url.searchParams.get('tail')) : undefined;
    if (tail !== undefined && !Number.isFinite(tail)) {
      throw new HttpError(400, 'tail must be a number.');
    }
    sendJson(res, 200, await im.instances.proxyLogs({ tail }));
    return true;
  }
  if (path === '/api/server/preflight' && ctx.method === 'POST') {
    await handlePreflight(srv, ctx, res);
    return true;
  }

  if (path === '/api/instances' && ctx.method === 'GET') {
    sendJson(res, 200, { instances: await im.instances.list() });
    return true;
  }
  if (path === '/api/instances' && ctx.method === 'POST') {
    // Server-authoritative registry: the official registry is the default;
    // a custom URL must at least be http(s).
    const body = { registryUrl: srv.defaultRegistryUrl, ...((ctx.body ?? {}) as Partial<CreateInstanceRequest>) };
    if (!/^https?:\/\//.test(body.registryUrl)) throw new HttpError(400, 'registryUrl must be http(s).');
    // Same rules the create wizard enforces field-by-field (shared module),
    // re-checked server-side so the API cannot be driven past them.
    const problems = validateCreateInstance(body);
    if (problems.length > 0) throw new HttpError(400, problems.join(' '));
    const req = body as CreateInstanceRequest;
    await start('instance_create', req.instanceId, (opCtx) => im.instances.create(req, opCtx));
    return true;
  }

  const m = path.match(/^\/api\/instances\/([^/]+)(\/.*)?$/);
  if (!m) return false;
  const instanceId = requireInstanceId(m[1]);
  const rest = m[2] ?? '';

  if (rest === '' && ctx.method === 'GET') {
    const detail = await im.instances.detail(instanceId);
    if (!detail) throw new HttpError(404, `Instance "${instanceId}" not found.`);
    sendJson(res, 200, detail);
    return true;
  }
  if (rest === '/backups' && ctx.method === 'GET') {
    sendJson(res, 200, { backups: await im.instances.backups(instanceId) });
    return true;
  }
  if (rest === '/plugins' && ctx.method === 'GET') {
    // Live installed-plugin read; `plugins: null` => instance down/unreachable
    // (the UI then falls back to the manifest's recorded list).
    sendJson(res, 200, { plugins: await im.instances.livePlugins(instanceId) });
    return true;
  }
  if (rest === '/backup-schedule' && ctx.method === 'GET') {
    sendJson(res, 200, await im.instances.backupSchedule(instanceId));
    return true;
  }
  if (rest === '/backup-schedule' && ctx.method === 'PUT') {
    // Server-authoritative validation: the client must send a complete,
    // well-formed policy; anything else is rejected with the exact problems.
    const raw = (ctx.body ?? {}) as Partial<BackupSchedulePolicy>;
    const policy: BackupSchedulePolicy = {
      enabled: raw.enabled as boolean,
      time: raw.time as string,
      retention: {
        daily: raw.retention?.daily as number,
        weekly: raw.retention?.weekly as number,
        monthly: raw.retention?.monthly as number,
        maxAgeDays: raw.retention?.maxAgeDays as number,
      },
    };
    const problems = validateSchedulePolicy(policy);
    if (problems.length > 0) throw new HttpError(400, problems.join(' '));
    sendJson(res, 200, await im.instances.setBackupSchedule(instanceId, policy));
    return true;
  }
  if (rest === '/backup-prune' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as { dryRun?: boolean };
    if (body.dryRun === true) {
      // Read-only preview: plan without deleting anything.
      sendJson(res, 200, await im.instances.backupPrunePlan(instanceId));
      return true;
    }
    await start('instance_backup_prune', instanceId, (opCtx) => im.instances.backupPrune(instanceId, opCtx));
    return true;
  }
  if (rest === '/health' && ctx.method === 'POST') {
    sendJson(res, 200, await im.instances.health(instanceId));
    return true;
  }
  if (rest === '/mailer' && ctx.method === 'GET') {
    sendJson(res, 200, await im.instances.mailer(instanceId));
    return true;
  }
  if (rest === '/mailer' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as Partial<SetMailerRequest>;
    const clearing = body.clear === true || body.dsn === undefined || body.dsn === '';
    if (!clearing && !MAILER_DSN_RE.test(body.dsn!)) {
      throw new HttpError(400, 'Mailer DSN must look like scheme://… (e.g. smtp://user:pass@mail.example.org:587).');
    }
    const req = body as SetMailerRequest;
    await start('instance_set_mailer', instanceId, (opCtx) => im.instances.setMailer(instanceId, req, opCtx));
    return true;
  }
  if (rest === '/name' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as Partial<SetNameRequest>;
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (displayName === '') throw new HttpError(400, 'A display name is required.');
    if (displayName.length > 200) throw new HttpError(400, 'Display name is too long (max 200 characters).');
    const req: SetNameRequest = { displayName };
    await start('instance_set_name', instanceId, (opCtx) => im.instances.setName(instanceId, req, opCtx));
    return true;
  }
  if (rest === '/env' && ctx.method === 'GET') {
    sendJson(res, 200, await im.instances.envConfig(instanceId));
    return true;
  }
  if (rest === '/logs' && ctx.method === 'GET') {
    const serviceParam = ctx.url.searchParams.get('service') ?? 'backend';
    if (!(LOG_SERVICES as readonly string[]).includes(serviceParam)) {
      throw new HttpError(400, `Unknown service "${serviceParam}". Choose one of: ${LOG_SERVICES.join(', ')}.`);
    }
    const tailRaw = ctx.url.searchParams.get('tail');
    const tail = tailRaw !== null && tailRaw !== '' ? Number(tailRaw) : undefined;
    if (tail !== undefined && !Number.isFinite(tail)) {
      throw new HttpError(400, 'tail must be a number.');
    }
    sendJson(res, 200, await im.instances.logs(instanceId, { service: serviceParam as LogService, tail }));
    return true;
  }
  if (rest === '/env' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as Partial<SetEnvRequest>;
    const overrides = body.overrides;
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new HttpError(400, 'overrides must be an object of KEY=value pairs.');
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value !== 'string') {
        throw new HttpError(400, `The value for ${key} must be a string.`);
      }
    }
    const req = { overrides } as SetEnvRequest;
    await start('instance_set_env', instanceId, (opCtx) => im.instances.setEnv(instanceId, req, opCtx));
    return true;
  }
  if (rest === '/update/dry-run' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as UpdateInstanceRequest;
    sendJson(res, 200, { plan: await im.instances.updateDryRun(instanceId, body) });
    return true;
  }
  if (rest === '/update' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as UpdateInstanceRequest;
    await start('instance_update', instanceId, (opCtx) => im.instances.update(instanceId, body, opCtx));
    return true;
  }
  if (rest === '/frontend-update/dry-run' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as FrontendUpdateInstanceRequest;
    sendJson(res, 200, { plan: await im.instances.frontendUpdateDryRun(instanceId, body) });
    return true;
  }
  if (rest === '/frontend-update' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as FrontendUpdateInstanceRequest;
    await start('instance_frontend_update', instanceId, (opCtx) => im.instances.frontendUpdate(instanceId, body, opCtx));
    return true;
  }
  if (rest === '/backups' && ctx.method === 'POST') {
    await start('instance_backup', instanceId, (opCtx) => im.instances.backup(instanceId, opCtx));
    return true;
  }
  const restoreMatch = rest.match(/^\/backups\/([a-z0-9-]+)\/restore$/i);
  if (restoreMatch && ctx.method === 'POST') {
    const backupId = restoreMatch[1]!;
    await start('instance_restore', instanceId, (opCtx) => im.instances.restore(instanceId, { backupId }, opCtx));
    return true;
  }
  if (rest === '/clone' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as Partial<CloneInstanceRequest>;
    // Mode-aware requirements: a production source needs a NEW domain, a
    // local source a NEW localhost port. The source's mode comes from its
    // manifest — never from the client.
    const detail = await im.instances.detail(instanceId);
    if (!detail) throw new HttpError(404, `Instance "${instanceId}" not found.`);
    const sourceMode = detail.summary.mode === 'local' ? 'local' : 'production';
    const problems = validateCloneInstance({
      sourceInstanceId: instanceId,
      sourceMode,
      sourceDomain: detail.summary.domain,
      ...(body.targetInstanceId ? { targetInstanceId: body.targetInstanceId } : {}),
      ...(body.targetDomain ? { targetDomain: body.targetDomain } : {}),
      ...(body.targetLocalPort !== undefined ? { targetLocalPort: body.targetLocalPort } : {}),
    });
    if (problems.length > 0) throw new HttpError(400, problems.join(' '));
    const req = body as CloneInstanceRequest;
    // Lock the SOURCE instance: the clone reads its DB/volumes, so no other
    // mutation may run on it concurrently. The target does not exist yet.
    await start('instance_clone', instanceId, (opCtx) => im.instances.clone(instanceId, req, opCtx));
    return true;
  }
  if (rest === '/address' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as Partial<SetAddressRequest>;
    const detail = await im.instances.detail(instanceId);
    if (!detail) throw new HttpError(404, `Instance "${instanceId}" not found.`);
    const mode = detail.summary.mode === 'local' ? 'local' : 'production';
    const problems = validateAddressChange({
      mode,
      ...(body.domain ? { domain: body.domain } : {}),
      ...(body.localPort !== undefined ? { localPort: body.localPort } : {}),
    });
    if (problems.length > 0) throw new HttpError(400, problems.join(' '));
    const req = body as SetAddressRequest;
    await start('instance_set_address', instanceId, (opCtx) => im.instances.setAddress(instanceId, req, opCtx));
    return true;
  }
  if (rest === '/disable' && ctx.method === 'POST') {
    // Reversible quiesce: stop containers, keep all data (status -> disabled).
    await start('instance_disable', instanceId, (opCtx) => im.instances.disable(instanceId, opCtx));
    return true;
  }
  if (rest === '/enable' && ctx.method === 'POST') {
    // Inverse of disable: bring the instance back online (status -> active).
    await start('instance_enable', instanceId, (opCtx) => im.instances.enable(instanceId, opCtx));
    return true;
  }
  if (rest === '/safe-mode' && ctx.method === 'POST') {
    // Toggle the backend safe-mode marker (plugins on/off). `enable` is
    // mandatory and explicit so the operator chooses the direction.
    const body = (ctx.body ?? {}) as Partial<SafeModeRequest>;
    if (typeof body.enable !== 'boolean') throw new HttpError(400, 'enable (boolean) is required.');
    const req: SafeModeRequest = { enable: body.enable };
    await start('instance_safe_mode', instanceId, (opCtx) => im.instances.safeMode(instanceId, req, opCtx));
    return true;
  }
  if (rest === '/plugin-recover' && ctx.method === 'POST') {
    // Recover a backend crash-looping on a half-removed plugin (safe mode ->
    // drain pending uninstall -> repair bundles -> verify a clean boot).
    await start('instance_plugin_recover', instanceId, (opCtx) => im.instances.pluginRecover(instanceId, opCtx));
    return true;
  }
  if (rest === '/remove' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as Partial<RemoveInstanceRequest>;
    if (!body.mode) throw new HttpError(400, 'mode is required (disable | remove_containers_keep_data | full_delete).');
    const req = body as RemoveInstanceRequest;
    await start('instance_remove', instanceId, (opCtx) => im.instances.remove(instanceId, req, opCtx));
    return true;
  }

  return false;
}
