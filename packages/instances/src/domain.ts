// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Production domain validation: duplicate-domain prevention against the server
 * inventory plus optional DNS-resolves-to-this-server checking. Pure so the
 * install path stays unit-testable; the impure DNS/public-IP probes are injected
 * by the CLI deps layer (see apps/cli/src/env.ts).
 *
 * Local Docker testing mode never requires public DNS — only a localPort.
 */
import type { InstanceMode } from '@shm/schemas';

// RFC-1123-ish: 1..253 chars, dot-separated labels of 1..63 chars, no leading/
// trailing hyphen, at least two labels (a public domain needs a TLD).
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

export function isValidPublicHostname(domain: string): boolean {
  const d = domain.trim();
  if (d.length === 0 || d.length > 253) return false;
  if (d.includes(':') || d.includes('/')) return false; // no port / path in a production domain
  if (d.toLowerCase() === 'localhost') return false;
  return HOSTNAME_RE.test(d);
}

export interface DnsResolution {
  a: string[];
  aaaa: string[];
}

export type DnsBindingStatus = 'match' | 'mismatch' | 'no-records';

export interface DnsBinding {
  status: DnsBindingStatus;
  detail: string;
}

/**
 * Compares a domain's resolved records to this server's public IP. When the IP
 * is unknown we can still confirm the domain resolves at all (catches typos and
 * un-provisioned domains) but cannot prove it points here.
 */
export function evaluateDnsBinding(resolution: DnsResolution, serverPublicIp?: string): DnsBinding {
  const all = [...resolution.a, ...resolution.aaaa];
  if (all.length === 0) {
    return { status: 'no-records', detail: 'Domain has no A/AAAA DNS records.' };
  }
  if (serverPublicIp && !all.includes(serverPublicIp)) {
    return {
      status: 'mismatch',
      detail: `Domain resolves to ${all.join(', ')} but this server is ${serverPublicIp}.`,
    };
  }
  return {
    status: 'match',
    detail: serverPublicIp
      ? `Domain resolves to this server (${serverPublicIp}).`
      : `Domain resolves to ${all.join(', ')}.`,
  };
}

export interface DomainValidationInput {
  mode: InstanceMode;
  domain?: string;
  localPort?: number;
  /** Domains already present in the server inventory (any instance). */
  existingDomains: string[];
  /** Resolved DNS records for the domain (omit to skip the DNS binding check). */
  dns?: DnsResolution;
  /** This server's public IP, when known, to prove the domain points here. */
  serverPublicIp?: string;
  /** Production: treat DNS problems as hard errors instead of warnings. */
  strictDns?: boolean;
  /** When re-validating an existing instance, ignore its own current domain. */
  excludeInstanceDomain?: string;
}

export interface DomainValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const norm = (d: string): string => d.trim().toLowerCase();

/**
 * Validates a domain/port for an install. Duplicate domains are always a hard
 * error (plan invariant: instances are isolated and a domain maps to exactly one
 * instance). DNS problems warn by default and block only when `strictDns` is set.
 */
export function validateDomainForInstall(input: DomainValidationInput): DomainValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.mode !== 'production') {
    if (input.localPort === undefined) {
      errors.push('Local install requires a localPort.');
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  const domain = input.domain ? norm(input.domain) : '';
  if (domain === '') {
    errors.push('Production install requires a domain.');
    return { ok: false, errors, warnings };
  }
  if (!isValidPublicHostname(domain)) {
    errors.push(`"${input.domain}" is not a valid public domain name.`);
  }

  const existing = new Set(input.existingDomains.map(norm));
  if (input.excludeInstanceDomain) existing.delete(norm(input.excludeInstanceDomain));
  if (existing.has(domain)) {
    errors.push(`Domain "${domain}" is already used by another instance on this server.`);
  }

  if (input.dns) {
    const binding = evaluateDnsBinding(input.dns, input.serverPublicIp);
    if (binding.status !== 'match') {
      const msg = `DNS check: ${binding.detail}`;
      if (input.strictDns) errors.push(msg);
      else warnings.push(msg);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
