// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  generateState,
  generateNonce,
  generatePkce,
  buildAuthorizationUrl,
  buildLogoutUrl,
  validateState,
  discover,
  fetchJwks,
  exchangeCode,
  decodeJwt,
  verifyIdToken,
  authorizeIdentity,
  type Jwk,
  type JsonHttp,
} from './oidc.js';
import type { CampusProviderConfig } from './config.js';

const provider: CampusProviderConfig = {
  enabled: true,
  displayName: 'Generic Campus',
  issuer: 'https://idp.example.org/',
  clientId: 'selfhelp-manager',
  clientSecretFile: '/secrets/oidc_client_secret',
  redirectUri: 'https://manager.example.org/auth/oidc/callback',
  postLogoutRedirectUri: 'https://manager.example.org/',
  allowedEmailDomains: ['example.org'],
  roleMappings: [{ match: { domain: 'example.org' }, roles: ['instance_operator'] }],
  scopes: ['openid', 'profile', 'email', 'groups'],
};

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

interface SignedToken {
  idToken: string;
  jwk: Jwk;
}

function makeIdToken(payload: Record<string, unknown>, kid = 'test-key'): SignedToken {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey as KeyObject).export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } as Jwk;
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(privateKey).toString('base64url');
  return { idToken: `${signingInput}.${signature}`, jwk };
}

describe('PKCE + flow building', () => {
  it('generates a state, nonce, and S256 PKCE pair', () => {
    expect(generateState()).not.toBe(generateState());
    expect(generateNonce()).toBeTruthy();
    const pkce = generatePkce();
    expect(pkce.method).toBe('S256');
    expect(pkce.verifier).toBeTruthy();
    expect(pkce.challenge).not.toBe(pkce.verifier);
  });

  it('builds an authorization URL with PKCE + scopes', () => {
    const url = new URL(
      buildAuthorizationUrl(provider, {
        authorizationEndpoint: 'https://idp.example.org/authorize',
        state: 'st',
        nonce: 'no',
        codeChallenge: 'cc',
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('selfhelp-manager');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('openid');
  });

  it('builds a logout URL with the post-logout redirect', () => {
    const url = new URL(buildLogoutUrl(provider, { endSessionEndpoint: 'https://idp.example.org/logout', idTokenHint: 'tok' }));
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://manager.example.org/');
    expect(url.searchParams.get('id_token_hint')).toBe('tok');
  });

  it('validates the state echo', () => {
    expect(validateState('abc', 'abc')).toBe(true);
    expect(validateState('abc', 'xyz')).toBe(false);
    expect(validateState('', '')).toBe(false);
  });
});

describe('discovery + token exchange (injected http)', () => {
  const discoveryDoc = {
    issuer: 'https://idp.example.org',
    authorization_endpoint: 'https://idp.example.org/authorize',
    token_endpoint: 'https://idp.example.org/token',
    jwks_uri: 'https://idp.example.org/jwks',
    end_session_endpoint: 'https://idp.example.org/logout',
  };

  it('discovers endpoints and fetches JWKS', async () => {
    const http: JsonHttp = async (url) => {
      if (url.includes('.well-known')) return { status: 200, json: discoveryDoc };
      if (url.endsWith('/jwks')) return { status: 200, json: { keys: [{ kty: 'RSA', kid: 'k1' }] } };
      return { status: 404, json: {} };
    };
    const disco = await discover('https://idp.example.org/', http);
    expect(disco.token_endpoint).toBe('https://idp.example.org/token');
    const jwks = await fetchJwks(disco.jwks_uri, http);
    expect(jwks.keys[0]?.kid).toBe('k1');
  });

  it('exchanges an authorization code for tokens', async () => {
    const http: JsonHttp = async (_url, init) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toContain('grant_type=authorization_code');
      expect(init?.body).toContain('code_verifier=');
      return { status: 200, json: { id_token: 'header.payload.sig', token_type: 'Bearer' } };
    };
    const token = await exchangeCode(
      provider,
      { tokenEndpoint: discoveryDoc.token_endpoint, code: 'abc', codeVerifier: 'ver', clientSecret: 'shh' },
      http,
    );
    expect(token.id_token).toBe('header.payload.sig');
  });

  it('throws when the token response has no id_token', async () => {
    const http: JsonHttp = async () => ({ status: 200, json: { token_type: 'Bearer' } });
    await expect(
      exchangeCode(provider, { tokenEndpoint: 't', code: 'a', codeVerifier: 'v', clientSecret: 's' }, http),
    ).rejects.toThrow(/id_token/);
  });
});

describe('ID-token verification (real RS256)', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const basePayload = {
    iss: 'https://idp.example.org',
    aud: 'selfhelp-manager',
    exp: Math.floor(now.getTime() / 1000) + 3600,
    nonce: 'n-123',
    email: 'staff@example.org',
    groups: ['some-group'],
  };

  it('verifies a correctly-signed token and returns claims', () => {
    const { idToken, jwk } = makeIdToken(basePayload);
    const claims = verifyIdToken(idToken, {
      jwks: { keys: [jwk] },
      issuer: provider.issuer,
      clientId: provider.clientId,
      nonce: 'n-123',
      now,
    });
    expect(claims.email).toBe('staff@example.org');
    expect(claims.groups).toEqual(['some-group']);
  });

  it('rejects a token signed by a different key', () => {
    const { idToken } = makeIdToken(basePayload);
    const { jwk: otherJwk } = makeIdToken(basePayload);
    expect(() =>
      verifyIdToken(idToken, { jwks: { keys: [otherJwk] }, issuer: provider.issuer, clientId: provider.clientId, now }),
    ).toThrow(/signature/i);
  });

  it('rejects wrong audience, issuer, nonce, and expiry', () => {
    const { idToken, jwk } = makeIdToken(basePayload);
    const jwks = { keys: [jwk] };
    expect(() => verifyIdToken(idToken, { jwks, issuer: provider.issuer, clientId: 'someone-else', now })).toThrow(/audience/i);
    expect(() => verifyIdToken(idToken, { jwks, issuer: 'https://evil.example', clientId: provider.clientId, now })).toThrow(/issuer/i);
    expect(() =>
      verifyIdToken(idToken, { jwks, issuer: provider.issuer, clientId: provider.clientId, nonce: 'wrong', now }),
    ).toThrow(/nonce/i);
    const later = new Date(now.getTime() + 4000 * 1000);
    expect(() => verifyIdToken(idToken, { jwks, issuer: provider.issuer, clientId: provider.clientId, now: later })).toThrow(/expired/i);
  });

  it('rejects a non-RS256 (e.g. alg none) token', () => {
    const header = { alg: 'none', typ: 'JWT' };
    const token = `${b64urlJson(header)}.${b64urlJson(basePayload)}.`;
    const { jwk } = makeIdToken(basePayload);
    expect(() => verifyIdToken(token, { jwks: { keys: [jwk] }, issuer: provider.issuer, clientId: provider.clientId, now })).toThrow(/RS256/);
  });

  it('decodes JWT parts without verifying', () => {
    const { idToken } = makeIdToken(basePayload);
    const parts = decodeJwt(idToken);
    expect(parts.header.alg).toBe('RS256');
    expect(parts.payload.email).toBe('staff@example.org');
  });
});

describe('authorization gate', () => {
  it('authorizes an allowlisted domain identity through role mapping', () => {
    const r = authorizeIdentity({ email: 'staff@example.org' }, provider);
    expect(r.authorized).toBe(true);
    expect(r.roles).toContain('instance_operator');
  });

  it('rejects an identity outside every allowlist', () => {
    const r = authorizeIdentity({ email: 'attacker@evil.com' }, provider);
    expect(r.authorized).toBe(false);
  });

  it('accepts an explicitly extra-allowed email with the default role', () => {
    const r = authorizeIdentity({ email: 'guest@other.com' }, { ...provider, defaultRole: 'read_only' }, ['guest@other.com']);
    expect(r.authorized).toBe(true);
    expect(r.roles).toEqual(['read_only']);
  });
});
