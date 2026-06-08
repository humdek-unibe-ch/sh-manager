// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
  generateCloneSecrets,
  generateInstanceSecrets,
  instanceSecretFiles,
  renderSecretsEnv,
  secretEnvMap,
  secretsForRestore,
  writeInstanceSecrets,
  type InstanceSecrets,
  type SecretIO,
} from './secrets.js';

// Keep the RSA keygen cheap; tests only assert structure/isolation, not strength.
const opts = { jwtModulusLength: 2048 } as const;

const SECRET_FIELDS: (keyof InstanceSecrets)[] = [
  'appSecret',
  'databasePassword',
  'databaseRootPassword',
  'redisPassword',
  'mercureJwtSecret',
  'jwtPassphrase',
  'jwtPrivateKeyPem',
];

class RecordingSecretIO implements SecretIO {
  dirs: { dir: string; mode: number }[] = [];
  files: { file: string; contents: string; mode: number }[] = [];
  async ensureDir(dir: string, mode: number): Promise<void> {
    this.dirs.push({ dir, mode });
  }
  async writeFile(file: string, contents: string, mode: number): Promise<void> {
    this.files.push({ file, contents, mode });
  }
}

describe('generateInstanceSecrets', () => {
  it('produces a complete, non-empty secret set', () => {
    const s = generateInstanceSecrets(opts);
    for (const field of SECRET_FIELDS) {
      expect(String(s[field]).length).toBeGreaterThan(0);
    }
    expect(s.jwtPrivateKeyPem).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    expect(s.jwtPublicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('never produces the same secrets for two instances (isolation boundary)', () => {
    const a = generateInstanceSecrets(opts);
    const b = generateInstanceSecrets(opts);
    for (const field of SECRET_FIELDS) {
      expect(a[field]).not.toBe(b[field]);
    }
  });
});

describe('writeInstanceSecrets', () => {
  it('writes every secret file with 0600 and the secrets dirs with 0700', async () => {
    const io = new RecordingSecretIO();
    const secrets = generateInstanceSecrets(opts);
    const written = await writeInstanceSecrets('/opt/selfhelp/instances/website1/secrets', secrets, io);

    // Both the secrets dir and the jwt subdir are created 0700.
    expect(io.dirs.every((d) => d.mode === SECRET_DIR_MODE)).toBe(true);
    expect(io.dirs.map((d) => d.dir).some((d) => d.endsWith('jwt'))).toBe(true);

    // Every file is written 0600.
    expect(io.files.length).toBe(instanceSecretFiles(secrets).length);
    expect(io.files.every((f) => f.mode === SECRET_FILE_MODE)).toBe(true);
    expect(written.some((p) => p.endsWith('secrets.env'))).toBe(true);
    expect(written.some((p) => p.replace(/\\/g, '/').endsWith('jwt/private.pem'))).toBe(true);
  });

  it('writes the raw secret values only into 0600 files, never elsewhere', () => {
    const secrets = generateInstanceSecrets(opts);
    const envFile = instanceSecretFiles(secrets).find((f) => f.relPath === 'secrets.env');
    expect(envFile?.mode).toBe(SECRET_FILE_MODE);
    expect(envFile?.contents).toContain(`APP_SECRET=${secrets.appSecret}`);
  });
});

describe('clone secret isolation', () => {
  it('generates fresh secrets that share nothing with the source', () => {
    const source = generateInstanceSecrets(opts);
    const clone = generateCloneSecrets(opts);
    for (const field of SECRET_FIELDS) {
      expect(clone[field]).not.toBe(source[field]);
    }
  });
});

describe('restore secret policy', () => {
  it('preserves existing secrets for an in-place same-instance restore', () => {
    const existing = generateInstanceSecrets(opts);
    const result = secretsForRestore('same_instance', existing, opts);
    expect(result.regenerated).toBe(false);
    expect(result.secrets).toBe(existing);
  });

  it('requires the existing secrets for a same-instance restore', () => {
    expect(() => secretsForRestore('same_instance', undefined, opts)).toThrow(/existing instance secrets/);
  });

  it('generates fresh secrets for a restore-as-clone (no reuse of the source)', () => {
    const source = generateInstanceSecrets(opts);
    const result = secretsForRestore('restore_as_clone', source, opts);
    expect(result.regenerated).toBe(true);
    for (const field of SECRET_FIELDS) {
      expect(result.secrets[field]).not.toBe(source[field]);
    }
  });
});

describe('secretEnvMap', () => {
  it('embeds passwords into DB/Redis URLs with a user component (so redaction matches)', () => {
    const env = secretEnvMap(generateInstanceSecrets(opts));
    expect(env.DATABASE_URL).toMatch(/^mysql:\/\/selfhelp:[^@]+@mysql:3306\/selfhelp/);
    expect(env.REDIS_URL).toMatch(/^redis:\/\/default:[^@]+@redis:6379/);
    expect(env.MERCURE_PUBLISHER_JWT_KEY).toBe(env.MERCURE_JWT_SECRET);
  });

  it('renders a secrets.env with one line per secret', () => {
    const text = renderSecretsEnv(generateInstanceSecrets(opts));
    expect(text).toContain('APP_SECRET=');
    expect(text).toContain('JWT_PASSPHRASE=');
  });
});
