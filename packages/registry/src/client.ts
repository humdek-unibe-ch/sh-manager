// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Official registry client: connected fetch + schema/version gating +
 * signature verification + graceful registry-unavailable behaviour.
 *
 * Existing instances must keep running when the registry is unavailable, so
 * failures are reported as structured `RegistryError`s and the last successful
 * check is retained for read-only display.
 */
import {
  checkSchemaCompatibility,
  requiresManagerSatisfied,
  validateCoreRelease,
  validateFrontendRelease,
  validateRegistryIndex,
  type CoreRelease,
  type FrontendRelease,
  type RegistryIndex,
  type RegistryReleaseRef,
  type TrustedKeysFile,
} from '@shm/schemas';
import { sha256Hex } from './canonical.js';
import { verifyReleaseSignature, type VerificationResult } from './signature.js';

export type RegistryErrorCode =
  | 'registry_unavailable'
  | 'invalid_metadata'
  | 'schema_incompatible'
  | 'manager_outdated'
  | 'signature_invalid'
  | 'not_found';

export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  text: string;
  etag?: string;
}

export interface Fetcher {
  fetch(url: string): Promise<FetchResponse>;
}

class GlobalFetcher implements Fetcher {
  async fetch(url: string): Promise<FetchResponse> {
    const res = await fetch(url);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, etag: res.headers.get('etag') ?? undefined };
  }
}

export interface RegistryCheck {
  at: string;
  url: string;
  metadataSha256: string;
  etag?: string;
}

export interface RegistryClientOptions {
  baseUrl: string;
  trustedKeys: TrustedKeysFile;
  fetcher?: Fetcher;
  managerVersion?: string;
  /** When true, allow unsigned/dev releases (development mode only). */
  allowUnsigned?: boolean;
}

function joinUrl(base: string, rel: string): string {
  if (/^https?:\/\//i.test(rel)) return rel;
  return base.replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, '');
}

export class RegistryClient {
  private readonly baseUrl: string;
  private readonly trustedKeys: TrustedKeysFile;
  private readonly fetcher: Fetcher;
  private readonly managerVersion: string | undefined;
  private readonly allowUnsigned: boolean;
  private lastCheck: RegistryCheck | undefined;

  constructor(options: RegistryClientOptions) {
    this.baseUrl = options.baseUrl;
    this.trustedKeys = options.trustedKeys;
    this.fetcher = options.fetcher ?? new GlobalFetcher();
    this.managerVersion = options.managerVersion;
    this.allowUnsigned = options.allowUnsigned ?? false;
  }

  get lastSuccessfulCheck(): RegistryCheck | undefined {
    return this.lastCheck;
  }

  private async fetchJson(url: string): Promise<{ data: unknown; raw: string; etag?: string }> {
    let res: FetchResponse;
    try {
      res = await this.fetcher.fetch(url);
    } catch (err) {
      throw new RegistryError(
        'registry_unavailable',
        `Registry fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const code: RegistryErrorCode = res.status === 404 ? 'not_found' : 'registry_unavailable';
      throw new RegistryError(code, `Registry returned HTTP ${res.status} for ${url}.`);
    }
    let data: unknown;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new RegistryError('invalid_metadata', `Registry response at ${url} is not valid JSON.`);
    }
    return { data, raw: res.text, etag: res.etag };
  }

  /** Fetches + validates + schema-gates the unified registry index. */
  async getIndex(): Promise<RegistryIndex> {
    const url = joinUrl(this.baseUrl, 'registry.json');
    const { data, raw, etag } = await this.fetchJson(url);

    const validation = validateRegistryIndex(data);
    if (!validation.valid || !validation.value) {
      throw new RegistryError('invalid_metadata', `Invalid registry index: ${validation.errors.join('; ')}`);
    }
    const index = validation.value;

    const compat = checkSchemaCompatibility('registry', index.schemaVersion);
    if (!compat.compatible) {
      throw new RegistryError('schema_incompatible', compat.reason ?? 'Incompatible registry schema.');
    }
    const mgr = requiresManagerSatisfied(index.requiresManager, this.managerVersion);
    if (!mgr.satisfied) {
      throw new RegistryError('manager_outdated', mgr.reason ?? 'Manager is too old for this registry.');
    }

    this.lastCheck = {
      at: new Date().toISOString(),
      url,
      metadataSha256: sha256Hex(raw),
      ...(etag !== undefined ? { etag } : {}),
    };
    return index;
  }

  private async getRelease<T extends { security: { signature: string; keyId: string } }>(
    ref: RegistryReleaseRef,
    validate: (d: unknown) => { valid: boolean; value?: T; errors: string[] },
  ): Promise<{ release: T; verification: VerificationResult }> {
    const url = joinUrl(this.baseUrl, ref.releaseUrl);
    const { data } = await this.fetchJson(url);
    const validation = validate(data);
    if (!validation.valid || !validation.value) {
      throw new RegistryError('invalid_metadata', `Invalid release ${ref.id}@${ref.version}: ${validation.errors.join('; ')}`);
    }
    const release = validation.value;
    const verification = verifyReleaseSignature(
      release as unknown as { security: { signature: string; keyId: string } } & Record<string, unknown>,
      this.trustedKeys,
    );
    if (!verification.verified && !this.allowUnsigned) {
      throw new RegistryError(
        'signature_invalid',
        `Release ${ref.id}@${ref.version} failed signature verification: ${verification.reason}`,
      );
    }
    return { release, verification };
  }

  getCoreRelease(ref: RegistryReleaseRef) {
    return this.getRelease<CoreRelease>(ref, validateCoreRelease);
  }

  getFrontendRelease(ref: RegistryReleaseRef) {
    return this.getRelease<FrontendRelease>(ref, validateFrontendRelease);
  }
}
