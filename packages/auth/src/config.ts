// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Manager operator roles.
 *
 * The SelfHelp Manager authenticates operators LOCALLY (email + password,
 * first-run bootstrap) and is reachable only on the server itself — remote use
 * is over an SSH tunnel, so no port is exposed publicly. There is intentionally
 * no campus/OIDC/SSO login: that idea (a UniBE campus account via the old
 * Symfony `sh-shp-auth_external` plugin) was dropped in favour of the local +
 * SSH-tunnel model, and its code has been removed.
 */
export type ManagerRole = 'server_owner' | 'instance_operator' | 'read_only';

export const MANAGER_ROLES: ManagerRole[] = ['server_owner', 'instance_operator', 'read_only'];
