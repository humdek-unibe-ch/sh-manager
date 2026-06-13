// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JWT_KEY_DIR_MODE,
  JWT_KEY_FILE_MODE,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
  ensureManagerToken,
  generateCloneSecrets,
  generateInstanceSecrets,
  instanceSecretFiles,
  readInstanceSecrets,
  redactMailerDsn,
  renderSecretsEnv,
  secretEnvMap,
  secretsForRestore,
  withMailerDsn,
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
  'managerToken',
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
  it('writes secret files 0600 (dir 0700) and the mounted jwt keypair 0644 (dir 0755)', async () => {
    const io = new RecordingSecretIO();
    const secrets = generateInstanceSecrets(opts);
    const written = await writeInstanceSecrets('/opt/selfhelp/instances/website1/secrets', secrets, io);

    // The secrets dir stays 0700; the bind-mounted jwt subdir must be 0755 so
    // the containers' www-data (uid 33) can traverse it on a Linux host.
    const jwtDir = io.dirs.find((d) => d.dir.endsWith('jwt'));
    const otherDirs = io.dirs.filter((d) => d !== jwtDir);
    expect(jwtDir?.mode).toBe(JWT_KEY_DIR_MODE);
    expect(otherDirs.every((d) => d.mode === SECRET_DIR_MODE)).toBe(true);

    // Regression: the jwt keypair is read by uid 33 inside the containers;
    // 0600 host files made JWT signing fail and every CMS login 500 in CI.
    // The private key is passphrase-encrypted, so 0644 leaks nothing usable.
    expect(io.files.length).toBe(instanceSecretFiles(secrets).length);
    for (const f of io.files) {
      const isJwtKey = /jwt[\\/](private|public)\.pem$/.test(f.file);
      expect(f.mode).toBe(isJwtKey ? JWT_KEY_FILE_MODE : SECRET_FILE_MODE);
    }
    expect(written.some((p) => p.endsWith('secrets.env'))).toBe(true);
    expect(written.some((p) => p.replace(/\\/g, '/').endsWith('jwt/private.pem'))).toBe(true);
  });

  it('keeps the mounted private key passphrase-encrypted and the passphrase out of the mount', () => {
    const secrets = generateInstanceSecrets(opts);
    const files = instanceSecretFiles(secrets);
    const privateKey = files.find((f) => f.relPath === 'jwt/private.pem');
    expect(privateKey?.contents).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    // The passphrase lives only in 0600 files outside the jwt/ mount dir.
    const passphraseCarriers = files.filter((f) => f.contents.includes(secrets.jwtPassphrase));
    expect(passphraseCarriers.length).toBeGreaterThan(0);
    for (const f of passphraseCarriers) {
      expect(f.relPath.startsWith('jwt/')).toBe(false);
      expect(f.mode).toBe(SECRET_FILE_MODE);
    }
  });

  it('writes the raw secret values only into 0600 files, never elsewhere', () => {
    const secrets = generateInstanceSecrets(opts);
    const envFile = instanceSecretFiles(secrets).find((f) => f.relPath === 'secrets.env');
    expect(envFile?.mode).toBe(SECRET_FILE_MODE);
    expect(envFile?.contents).toContain(`APP_SECRET=${secrets.appSecret}`);
  });
});

describe('readInstanceSecrets', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const makeSecretsDir = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shm-secrets-'));
    tempDirs.push(dir);
    return path.join(dir, 'secrets');
  };

  it('reads a previously written set back unchanged (retry continues with the same credentials)', async () => {
    const secretsDir = await makeSecretsDir();
    const written = generateInstanceSecrets(opts);
    await writeInstanceSecrets(secretsDir, written);

    const read = await readInstanceSecrets(secretsDir);
    expect(read).not.toBeNull();
    expect(read).toEqual(written);
  });

  it('returns null when no secrets were ever written (fresh install)', async () => {
    const secretsDir = await makeSecretsDir();
    expect(await readInstanceSecrets(secretsDir)).toBeNull();
  });

  it('returns null for an incomplete set instead of guessing (e.g. missing JWT keys)', async () => {
    const secretsDir = await makeSecretsDir();
    const written = generateInstanceSecrets(opts);
    await writeInstanceSecrets(secretsDir, written);
    await rm(path.join(secretsDir, 'jwt', 'private.pem'), { force: true });

    expect(await readInstanceSecrets(secretsDir)).toBeNull();
  });

  it('tolerates a pre-token secrets.env (manager token empty, set still readable)', async () => {
    const secretsDir = await makeSecretsDir();
    const written = generateInstanceSecrets(opts);
    // Simulate an install from before the manager token existed.
    const legacy = { ...written, managerToken: '' };
    await writeInstanceSecrets(secretsDir, legacy);

    const read = await readInstanceSecrets(secretsDir);
    expect(read).not.toBeNull();
    expect(read?.managerToken).toBe('');
    expect(read?.appSecret).toBe(written.appSecret);
  });
});

describe('ensureManagerToken', () => {
  it('keeps an existing token unchanged', () => {
    const secrets = generateInstanceSecrets(opts);
    const result = ensureManagerToken(secrets);
    expect(result.minted).toBe(false);
    expect(result.secrets).toBe(secrets);
  });

  it('mints a token for a pre-token set without touching other secrets', () => {
    const secrets = { ...generateInstanceSecrets(opts), managerToken: '' };
    const result = ensureManagerToken(secrets);
    expect(result.minted).toBe(true);
    expect(result.secrets.managerToken.length).toBeGreaterThan(0);
    expect(result.secrets.appSecret).toBe(secrets.appSecret);
    expect(result.secrets.databasePassword).toBe(secrets.databasePassword);
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

  it('injects the per-instance manager token so the backend update loop is enabled', () => {
    const secrets = generateInstanceSecrets(opts);
    const env = secretEnvMap(secrets);
    expect(env.SELFHELP_MANAGER_TOKEN).toBe(secrets.managerToken);
    expect(secrets.managerToken.length).toBeGreaterThan(0);
  });
});

describe('mailer DSN override (operator SMTP)', () => {
  const DSN = 'smtp://mailuser:s3cret-pw@mail.example.org:587';

  it('is never part of a generated secret set (opt-in only)', () => {
    expect(generateInstanceSecrets(opts).mailerDsn).toBeUndefined();
  });

  it('withMailerDsn sets, keeps and clears the override (empty string = back to Mailpit)', () => {
    const base = generateInstanceSecrets(opts);
    const set = withMailerDsn(base, DSN);
    expect(set.mailerDsn).toBe(DSN);
    // undefined leaves whatever is configured untouched.
    expect(withMailerDsn(set, undefined).mailerDsn).toBe(DSN);
    // empty string REMOVES the key entirely, so secrets.env carries no
    // MAILER_DSN line and the non-secret Mailpit default applies again.
    const cleared = withMailerDsn(set, '');
    expect('mailerDsn' in cleared).toBe(false);
    expect(secretEnvMap(cleared)).not.toHaveProperty('MAILER_DSN');
  });

  it('lands in the 0600 secrets.env (it may carry SMTP credentials), overriding Mailpit', () => {
    const secrets = withMailerDsn(generateInstanceSecrets(opts), DSN);
    expect(secretEnvMap(secrets).MAILER_DSN).toBe(DSN);
    const envFile = instanceSecretFiles(secrets).find((f) => f.relPath === 'secrets.env');
    expect(envFile?.mode).toBe(SECRET_FILE_MODE);
    expect(envFile?.contents).toContain(`MAILER_DSN=${DSN}`);
  });

  it('survives the write -> read round-trip (preserved across retries/updates)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shm-mailer-'));
    try {
      const secretsDir = path.join(dir, 'secrets');
      await writeInstanceSecrets(secretsDir, withMailerDsn(generateInstanceSecrets(opts), DSN));
      const read = await readInstanceSecrets(secretsDir);
      expect(read?.mailerDsn).toBe(DSN);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redactMailerDsn masks credentials but keeps scheme/host/port for display', () => {
    expect(redactMailerDsn(DSN)).toBe('smtp://***@mail.example.org:587');
    expect(redactMailerDsn(DSN)).not.toContain('s3cret-pw');
    expect(redactMailerDsn(DSN)).not.toContain('mailuser');
    // A DSN without userinfo has nothing to hide.
    expect(redactMailerDsn('smtp://mail.example.org:587')).toBe('smtp://mail.example.org:587');
  });
});
