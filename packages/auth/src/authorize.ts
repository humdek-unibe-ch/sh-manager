// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Authorization decision for a campus-authenticated identity.
 *
 * Campus authentication proves identity only. Authorization to operate the
 * manager must come from explicit manager configuration (allowlisted email,
 * domain, group/claim, or role mapping). A campus-authenticated user who is
 * not authorized must be rejected.
 */
import type { CampusProviderConfig, ManagerRole } from './config.js';

export interface CampusClaims {
  email: string;
  groups?: string[];
  [claim: string]: unknown;
}

export interface AuthorizationResult {
  authorized: boolean;
  roles: ManagerRole[];
  reason?: string;
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

function claimGroups(config: CampusProviderConfig, claims: CampusClaims): string[] {
  const claimKey = config.roleClaim ?? 'groups';
  const raw = claimKey === 'groups' ? claims.groups : claims[claimKey];
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
  if (typeof raw === 'string') return [raw];
  return [];
}

export function authorizeOperator(
  claims: CampusClaims,
  config: CampusProviderConfig,
): AuthorizationResult {
  if (!config.enabled) {
    return { authorized: false, roles: [], reason: 'Campus provider is disabled.' };
  }
  const email = claims.email?.toLowerCase().trim();
  if (!email) {
    return { authorized: false, roles: [], reason: 'No email claim present.' };
  }

  const groups = claimGroups(config, claims);
  const domain = emailDomain(email);

  const emailAllowed = (config.allowedEmails ?? []).map((e) => e.toLowerCase()).includes(email);
  const domainAllowed = (config.allowedEmailDomains ?? []).map((d) => d.toLowerCase()).includes(domain);
  const groupAllowed = groups.some((g) => (config.allowedGroups ?? []).includes(g));

  if (!emailAllowed && !domainAllowed && !groupAllowed) {
    return {
      authorized: false,
      roles: [],
      reason: 'Identity is authenticated but not on any manager allowlist (email/domain/group).',
    };
  }

  // Resolve roles from explicit mappings.
  const roles = new Set<ManagerRole>();
  for (const mapping of config.roleMappings) {
    const m = mapping.match;
    const matches =
      (m.email !== undefined && m.email.toLowerCase() === email) ||
      (m.domain !== undefined && m.domain.toLowerCase() === domain) ||
      (m.group !== undefined && groups.includes(m.group));
    if (matches) for (const r of mapping.roles) roles.add(r);
  }

  if (roles.size === 0) {
    if (config.defaultRole) {
      roles.add(config.defaultRole);
    } else {
      return {
        authorized: false,
        roles: [],
        reason: 'Allowlisted but no manager role mapping matched; configure roleMappings or defaultRole.',
      };
    }
  }

  return { authorized: true, roles: [...roles] };
}
