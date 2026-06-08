// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { InstanceLock, InstanceManifest, SupportBundleMeta } from '@shm/schemas';
import { findResidualSecrets, redactEnv, redactObject, redactString } from './redact.js';

export interface SupportBundleInput {
  instanceId: string;
  managerVersion: string;
  schemaVersions: Record<string, number | string>;
  manifest: InstanceManifest;
  lock: InstanceLock;
  versionSummary: Record<string, unknown>;
  installedPlugins: { id: string; version: string }[];
  env: Record<string, string>;
  healthResults: unknown;
  composeStatus: string;
  logs: { backend?: string; frontend?: string; scheduler?: string; worker?: string };
  pluginDoctor?: string;
  registryCheck?: unknown;
  lastUpdateLogs?: string;
}

export interface SupportBundleFile {
  name: string;
  content: string;
}

export interface SupportBundle {
  meta: SupportBundleMeta;
  files: SupportBundleFile[];
}

function jsonFile(name: string, value: unknown): SupportBundleFile {
  return { name, content: JSON.stringify(redactObject(value), null, 2) };
}

/**
 * Assembles a fully redacted support bundle. Every text file passes through
 * redaction, and the bundle is scanned for residual secrets before return.
 */
export function assembleSupportBundle(input: SupportBundleInput): SupportBundle {
  const files: SupportBundleFile[] = [
    jsonFile('manifest.json', input.manifest),
    jsonFile('lock.json', input.lock),
    jsonFile('version-summary.json', input.versionSummary),
    jsonFile('installed-plugins.json', input.installedPlugins),
    jsonFile('health.json', input.healthResults),
    { name: 'env.redacted', content: Object.entries(redactEnv(input.env)).map(([k, v]) => `${k}=${v}`).join('\n') },
    { name: 'compose-status.txt', content: redactString(input.composeStatus) },
    { name: 'logs-backend.txt', content: redactString(input.logs.backend ?? '') },
    { name: 'logs-frontend.txt', content: redactString(input.logs.frontend ?? '') },
    { name: 'logs-scheduler.txt', content: redactString(input.logs.scheduler ?? '') },
    { name: 'logs-worker.txt', content: redactString(input.logs.worker ?? '') },
  ];
  if (input.pluginDoctor) files.push({ name: 'plugin-doctor.txt', content: redactString(input.pluginDoctor) });
  if (input.registryCheck) files.push(jsonFile('registry-check.json', input.registryCheck));
  if (input.lastUpdateLogs) files.push({ name: 'last-update.log', content: redactString(input.lastUpdateLogs) });

  const meta: SupportBundleMeta = {
    supportBundleVersion: 1,
    instanceId: input.instanceId,
    createdAt: new Date().toISOString(),
    managerVersion: input.managerVersion,
    schemaVersions: input.schemaVersions,
    redactionApplied: true,
    contents: files.map((f) => f.name),
  };

  const residual = files.flatMap((f) => findResidualSecrets(f.content).map((r) => `${f.name}: ${r}`));
  if (residual.length > 0) {
    throw new Error(`Support bundle still contains secrets after redaction: ${residual.join('; ')}`);
  }

  return { meta, files: [{ name: 'support-bundle.json', content: JSON.stringify(meta, null, 2) }, ...files] };
}
