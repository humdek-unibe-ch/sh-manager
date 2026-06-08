// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Configurable campus/OIDC login provider for SelfHelp Manager operators.
 *
 * This is a generic, TypeScript-native provider. It does NOT install, reuse,
 * or depend on the old Symfony/PHP `sh-shp-auth_external` plugin at runtime —
 * that plugin is reference-only. UniBE is one example configuration, not
 * hard-coded logic.
 */
export type ManagerRole = 'server_owner' | 'instance_operator' | 'read_only';

export const MANAGER_ROLES: ManagerRole[] = ['server_owner', 'instance_operator', 'read_only'];

export interface RoleMappingMatch {
  email?: string;
  group?: string;
  domain?: string;
}

export interface RoleMapping {
  match: RoleMappingMatch;
  roles: ManagerRole[];
}

export interface CampusProviderConfig {
  enabled: boolean;
  displayName: string;
  issuer: string;
  clientId: string;
  /** Path to a restricted file holding the client secret. Never the raw secret. */
  clientSecretFile: string;
  redirectUri: string;
  postLogoutRedirectUri?: string;
  allowedEmailDomains?: string[];
  allowedEmails?: string[];
  allowedGroups?: string[];
  roleClaim?: string;
  roleMappings: RoleMapping[];
  scopes?: string[];
  trustedCallbackUrl?: string;
  sessionLifetimeSeconds?: number;
  /** Optional default role assigned to allowlisted users with no explicit mapping. */
  defaultRole?: ManagerRole;
}

export interface CampusAuthConfig {
  mode: 'local' | 'campus';
  providers: Record<string, CampusProviderConfig>;
}

export interface ConfigValidation {
  ok: boolean;
  errors: string[];
}

/** Validates provider config without ever requiring the raw client secret. */
export function validateProviderConfig(config: CampusProviderConfig): ConfigValidation {
  const errors: string[] = [];
  if (!config.issuer) errors.push('issuer is required.');
  if (!config.clientId) errors.push('clientId is required.');
  if (!config.clientSecretFile) errors.push('clientSecretFile (path) is required; do not inline secrets.');
  if (!config.redirectUri) errors.push('redirectUri is required.');
  const hasAllowlist =
    (config.allowedEmails?.length ?? 0) > 0 ||
    (config.allowedEmailDomains?.length ?? 0) > 0 ||
    (config.allowedGroups?.length ?? 0) > 0;
  if (!hasAllowlist) {
    errors.push('At least one of allowedEmails/allowedEmailDomains/allowedGroups must be set.');
  }
  for (const m of config.roleMappings) {
    for (const r of m.roles) {
      if (!MANAGER_ROLES.includes(r)) errors.push(`Unknown manager role "${r}".`);
    }
  }
  return { ok: errors.length === 0, errors };
}
