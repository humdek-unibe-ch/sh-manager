// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildInstanceEnv, buildInstanceRouting, renderDotEnv } from './env.js';

const input = {
  instanceId: 'website1',
  mode: 'production' as const,
  selfhelpVersion: '1.5.0',
  publicFrontendUrl: 'https://website1.example.ch',
  mercurePublicUrl: 'https://website1.example.ch/.well-known/mercure',
};

describe('BFF URL invariant', () => {
  it('keeps browser traffic on /api and server-side on the internal URL', () => {
    const routing = buildInstanceRouting(input);
    expect(routing.browserApiPrefix).toBe('/api');
    expect(routing.internalSymfonyUrl).toMatch(/^http:\/\/backend:8080$/);
    expect(routing.symfonyApiPrefix).toBe('/cms-api/v1');
  });

  it('env never points the browser at the internal URL', () => {
    const env = buildInstanceEnv(input);
    expect(env.NEXT_PUBLIC_API_URL).toBe('/api');
    expect(env.SYMFONY_INTERNAL_URL).toBe('http://backend:8080');
    expect(env.NEXT_PUBLIC_API_URL).not.toContain('backend');
  });

  it('renders a .env without secrets', () => {
    const dotenv = renderDotEnv(buildInstanceEnv(input));
    expect(dotenv).toContain('SELFHELP_INSTANCE_ID=website1');
    expect(dotenv.toLowerCase()).not.toContain('password');
    expect(dotenv.toLowerCase()).not.toContain('secret=');
  });
});
