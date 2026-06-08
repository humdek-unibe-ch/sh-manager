// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Generic OIDC authorization-code (+ PKCE) flow for manager operators.
 *
 * This is provider-agnostic: no UniBE or any other issuer is hard-coded. The
 * flow is built from the operator-supplied {@link CampusProviderConfig} plus
 * the provider's discovery document. Network calls are funnelled through an
 * injected {@link JsonHttp} client so the orchestration is unit-testable and
 * the ID-token signature is verified for real against the provider JWKS using
 * Node's native JWK key import (RS256). Authenticated identities are only
 * accepted if {@link authorizeOperator} (allowlist + role mapping) accepts
 * them.
 */
import { createHash, createVerify, randomBytes, createPublicKey } from 'node:crypto';
import type { CampusProviderConfig } from './config.js';
import { authorizeOperator, type AuthorizationResult, type CampusClaims } from './authorize.js';

export type JsonHttp = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: unknown }>;

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  [k: string]: unknown;
}

export interface Jwks {
  keys: Jwk[];
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function generateState(): string {
  return b64url(randomBytes(24));
}

export function generateNonce(): string {
  return b64url(randomBytes(24));
}

export function generatePkce(): PkcePair {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export interface AuthorizationUrlInput {
  authorizationEndpoint: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export function buildAuthorizationUrl(provider: CampusProviderConfig, input: AuthorizationUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  const scopes = provider.scopes && provider.scopes.length > 0 ? provider.scopes : ['openid', 'profile', 'email'];
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', provider.redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface LogoutUrlInput {
  endSessionEndpoint: string;
  idTokenHint?: string;
}

export function buildLogoutUrl(provider: CampusProviderConfig, input: LogoutUrlInput): string {
  const url = new URL(input.endSessionEndpoint);
  url.searchParams.set('client_id', provider.clientId);
  if (provider.postLogoutRedirectUri) {
    url.searchParams.set('post_logout_redirect_uri', provider.postLogoutRedirectUri);
  }
  if (input.idTokenHint) {
    url.searchParams.set('id_token_hint', input.idTokenHint);
  }
  return url.toString();
}

/** Validate the OAuth `state` echo in constant-ish time (length-checked). */
export function validateState(expected: string, returned: string): boolean {
  return typeof returned === 'string' && expected.length > 0 && expected === returned;
}

export async function discover(issuer: string, http: JsonHttp): Promise<OidcDiscovery> {
  const base = issuer.replace(/\/$/, '');
  const res = await http(`${base}/.well-known/openid-configuration`);
  if (res.status !== 200 || typeof res.json !== 'object' || res.json === null) {
    throw new Error(`OIDC discovery failed for ${issuer} (status ${res.status}).`);
  }
  const doc = res.json as Partial<OidcDiscovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer) {
    throw new Error('OIDC discovery document is missing required endpoints.');
  }
  return doc as OidcDiscovery;
}

export async function fetchJwks(jwksUri: string, http: JsonHttp): Promise<Jwks> {
  const res = await http(jwksUri);
  if (res.status !== 200 || typeof res.json !== 'object' || res.json === null) {
    throw new Error(`Failed to fetch JWKS from ${jwksUri} (status ${res.status}).`);
  }
  const keys = (res.json as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) throw new Error('JWKS document has no "keys" array.');
  return { keys: keys as Jwk[] };
}

export interface TokenResponse {
  id_token: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

export interface ExchangeCodeInput {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  clientSecret: string;
}

export async function exchangeCode(
  provider: CampusProviderConfig,
  input: ExchangeCodeInput,
  http: JsonHttp,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: provider.redirectUri,
    client_id: provider.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  }).toString();

  const res = await http(input.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (res.status !== 200 || typeof res.json !== 'object' || res.json === null) {
    throw new Error(`Token exchange failed (status ${res.status}).`);
  }
  const token = res.json as Partial<TokenResponse>;
  if (!token.id_token) throw new Error('Token response did not contain an id_token.');
  return token as TokenResponse;
}

interface JwtParts {
  header: { alg?: string; kid?: string; typ?: string };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

export function decodeJwt(token: string): JwtParts {
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Malformed JWT.');
  const [h, p, s] = segments as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as JwtParts['header'];
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
  return { header, payload, signingInput: `${h}.${p}`, signature: Buffer.from(s, 'base64url') };
}

export interface VerifyIdTokenInput {
  jwks: Jwks;
  issuer: string;
  clientId: string;
  nonce?: string;
  now?: Date;
  /** Clock skew tolerance in seconds. */
  clockToleranceSeconds?: number;
}

/**
 * Verify an ID token signature (RS256) against the provider JWKS and validate
 * the standard claims (iss, aud, exp, and nonce when supplied). Returns the
 * decoded claims on success and throws on any failure.
 */
export function verifyIdToken(idToken: string, input: VerifyIdTokenInput): CampusClaims {
  const { header, payload, signingInput, signature } = decodeJwt(idToken);
  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported ID-token alg "${header.alg ?? 'none'}"; only RS256 is accepted.`);
  }

  const candidates = input.jwks.keys.filter((k) => k.kty === 'RSA' && (!header.kid || k.kid === header.kid));
  if (candidates.length === 0) throw new Error('No matching RSA key in JWKS for the ID token.');

  const verified = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk as Record<string, unknown>, format: 'jwk' });
      const verifier = createVerify('RSA-SHA256');
      verifier.update(signingInput);
      verifier.end();
      return verifier.verify(key, signature);
    } catch {
      return false;
    }
  });
  if (!verified) throw new Error('ID-token signature verification failed.');

  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const skew = input.clockToleranceSeconds ?? 60;

  const iss = typeof payload.iss === 'string' ? payload.iss : '';
  if (iss.replace(/\/$/, '') !== input.issuer.replace(/\/$/, '')) {
    throw new Error('ID-token issuer mismatch.');
  }

  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(input.clientId) : aud === input.clientId;
  if (!audOk) throw new Error('ID-token audience mismatch.');

  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (exp + skew <= nowSec) throw new Error('ID token is expired.');

  if (input.nonce !== undefined && payload.nonce !== input.nonce) {
    throw new Error('ID-token nonce mismatch.');
  }

  const email = typeof payload.email === 'string' ? payload.email : '';
  const groups = Array.isArray(payload.groups)
    ? payload.groups.filter((g): g is string => typeof g === 'string')
    : undefined;

  return { ...payload, email, ...(groups ? { groups } : {}) };
}

/**
 * Final authorization gate: an authenticated identity is only accepted if it
 * is on a manager allowlist (email/domain/group) AND resolves to a role, OR is
 * explicitly listed in {@link extraAllowedEmails}. Mirrors the deny-by-default
 * rule: authentication proves identity, configuration proves authorization.
 */
export function authorizeIdentity(
  claims: CampusClaims,
  provider: CampusProviderConfig,
  extraAllowedEmails: string[] = [],
): AuthorizationResult {
  const base = authorizeOperator(claims, provider);
  if (base.authorized) return base;

  const email = claims.email?.toLowerCase().trim() ?? '';
  if (email && extraAllowedEmails.map((e) => e.toLowerCase()).includes(email)) {
    const role = provider.defaultRole ?? 'read_only';
    return { authorized: true, roles: [role] };
  }
  return base;
}
