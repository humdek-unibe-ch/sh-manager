// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Pure request validation shared by the BFF (server.ts fail-fast 400s) and the
 * browser UI (inline field errors in the create/clone/address dialogs). One
 * module, one set of rules — the SPA can never accept a value the server
 * rejects, and vice versa. Must stay free of node imports (it is bundled into
 * the browser build).
 */

/** Lowercase letters/digits/hyphens, 3-40 chars (matches the wizard + CLI). */
export const INSTANCE_ID_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
/** RFC-1123-ish public hostname with a TLD. */
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Exact release version (1.2.3 with optional pre-release tag) or "latest". */
export const VERSION_RE = /^(latest|\d+\.\d+\.\d+(-[0-9a-z.-]+)?)$/i;

export function isValidLocalPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

export interface CreateInstanceShape {
  instanceId?: string;
  displayName?: string;
  mode?: string;
  domain?: string;
  localPort?: number;
  version?: string;
  adminEmail?: string;
}

/** Blocking problems for a create-instance request (empty = valid). */
export function validateCreateInstance(req: CreateInstanceShape): string[] {
  const errors: string[] = [];
  if (!req.instanceId || !INSTANCE_ID_RE.test(req.instanceId)) {
    errors.push('Instance id must be lowercase letters, digits and hyphens (3-40 chars).');
  }
  if (!req.displayName?.trim()) errors.push('Display name is required.');
  if (req.mode !== 'production' && req.mode !== 'local') {
    errors.push('Mode must be production or local.');
  } else if (req.mode === 'production') {
    if (!req.domain || !HOSTNAME_RE.test(req.domain)) {
      errors.push('A valid public domain is required for production instances.');
    }
  } else if (!isValidLocalPort(req.localPort)) {
    errors.push('A valid localhost port (1-65535) is required for local instances.');
  }
  if (req.version && !VERSION_RE.test(req.version)) {
    errors.push('Version must be an exact release version or "latest".');
  }
  if (!req.adminEmail || !EMAIL_RE.test(req.adminEmail)) {
    errors.push('A valid admin email is required.');
  }
  return errors;
}

export interface CloneInstanceShape {
  sourceInstanceId: string;
  /** Mode of the SOURCE — the clone always keeps it. */
  sourceMode: 'production' | 'local';
  /** Current source domain (production) or localhost:<port> (local). */
  sourceDomain?: string;
  targetInstanceId?: string;
  targetDomain?: string;
  targetLocalPort?: number;
}

/**
 * Blocking problems for a clone request. Production clones need a NEW domain;
 * local clones need a NEW localhost port — never both.
 */
export function validateCloneInstance(req: CloneInstanceShape): string[] {
  const errors: string[] = [];
  if (!req.targetInstanceId || !INSTANCE_ID_RE.test(req.targetInstanceId)) {
    errors.push('New instance id must be lowercase letters, digits and hyphens (3-40 chars).');
  } else if (req.targetInstanceId === req.sourceInstanceId) {
    errors.push('New instance id must differ from the source.');
  }
  if (req.sourceMode === 'production') {
    if (!req.targetDomain || !HOSTNAME_RE.test(req.targetDomain)) {
      errors.push('A valid public domain is required to clone a production instance.');
    } else if (req.sourceDomain && req.targetDomain.toLowerCase() === req.sourceDomain.toLowerCase()) {
      errors.push('The clone must not reuse the source domain.');
    }
  } else {
    if (!isValidLocalPort(req.targetLocalPort)) {
      errors.push('A valid localhost port (1-65535) is required to clone a local instance.');
    } else if (req.sourceDomain && `localhost:${req.targetLocalPort}` === req.sourceDomain) {
      errors.push('The clone must not reuse the source port.');
    }
  }
  return errors;
}

export interface AddressChangeShape {
  /** Mode of the instance — addresses never change the mode. */
  mode: 'production' | 'local';
  domain?: string;
  localPort?: number;
}

/**
 * Blocking problems for a change-address request (production: new domain;
 * local: new localhost port). Re-applying the CURRENT value is allowed — it
 * regenerates the runtime config and restarts, which is also the documented
 * way to repair an instance whose env/compose predates a manager fix.
 */
export function validateAddressChange(req: AddressChangeShape): string[] {
  const errors: string[] = [];
  if (req.mode === 'production') {
    if (!req.domain || !HOSTNAME_RE.test(req.domain)) {
      errors.push('A valid public domain is required for production instances.');
    }
  } else if (!isValidLocalPort(req.localPort)) {
    errors.push('A valid localhost port (1-65535) is required for local instances.');
  }
  return errors;
}
