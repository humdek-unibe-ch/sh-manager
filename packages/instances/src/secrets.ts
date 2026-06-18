// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Per-instance secret generation + secure secret-file writing.
 *
 * Every SelfHelp instance is an isolated security boundary, so it MUST own a
 * distinct set of runtime secrets: an `APP_SECRET`, a JWT keypair (+ passphrase),
 * a Mercure JWT secret, a database password (+ root password) and a Redis
 * password. These are NEVER:
 *   - shared between instances,
 *   - copied from the source on clone,
 *   - written into the manifest / lock / inventory / README,
 *   - emitted to logs or support bundles (the support redactor strips them).
 *
 * Secrets are written as `0600` files under `<instance>/secrets/` (`0700`). The
 * non-secret `.env` only references the JWT key *paths*; the actual secret
 * values live in `secrets/secrets.env`, which compose loads through `env_file`.
 * Exception: the bind-mounted `secrets/jwt/` keypair is `0644`/`0755` so the
 * containers' `www-data` user can read it (see {@link JWT_KEY_FILE_MODE}).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SECRET_FILE_MODE = 0o600;
export const SECRET_DIR_MODE = 0o700;
/**
 * The JWT keypair is the ONE exception to 0600/0700: `secrets/jwt/` is
 * bind-mounted read-only into the backend/worker/scheduler containers, whose
 * PHP runs as `www-data` (uid 33) while the host files belong to whoever runs
 * the manager (e.g. uid 1001 on a CI runner). With owner-only modes uid 33
 * cannot read the keys on a Linux host, so JWT signing fails and every login
 * 500s — while health/provision (which never touch the keys) stay green.
 * World-readable is safe here: the private key is AES-256 passphrase-encrypted
 * and the passphrase itself stays in 0600 files (`secrets.env`,
 * `jwt_passphrase`) that are NOT part of the mount.
 */
export const JWT_KEY_FILE_MODE = 0o644;
export const JWT_KEY_DIR_MODE = 0o755;
/** Path (relative to the instance dir) of the compose-loaded secret env file. */
export const SECRETS_ENV_RELATIVE_PATH = 'secrets/secrets.env';
/** Path (relative to the instance dir) of the JWT keypair directory. */
export const JWT_KEYS_RELATIVE_DIR = 'secrets/jwt';
/** Mount target of the JWT keys inside the backend/worker/scheduler containers. */
export const JWT_CONTAINER_DIR = '/app/config/jwt';

const DEFAULT_DATABASE_NAME = 'selfhelp';
const DEFAULT_DATABASE_USER = 'selfhelp';
const DEFAULT_JWT_MODULUS_LENGTH = 4096;

export interface InstanceSecrets {
  appSecret: string;
  databaseName: string;
  databaseUser: string;
  databasePassword: string;
  databaseRootPassword: string;
  redisPassword: string;
  mercureJwtSecret: string;
  jwtPassphrase: string;
  jwtPrivateKeyPem: string;
  jwtPublicKeyPem: string;
  /**
   * Per-instance bearer token for the CMS<->Manager update loop
   * (`SELFHELP_MANAGER_TOKEN` in the backend container). Empty string on
   * secret sets read back from a pre-token install — backfill with
   * {@link ensureManagerToken} before writing.
   */
  managerToken: string;
  /**
   * Operator-configured SMTP DSN (`smtp://user:pass@host:587`). NOT generated:
   * set at install or via `instance set-mailer`. Lives in secrets.env (0600)
   * because the DSN may embed credentials; it overrides the non-secret
   * `.env`'s Mailpit default (secrets.env loads after `.env` in compose).
   * Unset = the instance keeps the local Mailpit / image default.
   */
  mailerDsn?: string;
}

export interface GenerateSecretsOptions {
  /** RSA modulus for the JWT keypair. Tests may lower it for speed. */
  jwtModulusLength?: number;
  databaseName?: string;
  databaseUser?: string;
}

function hexToken(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function urlSafeToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** Generates a fresh, fully isolated secret set for one instance. */
export function generateInstanceSecrets(options: GenerateSecretsOptions = {}): InstanceSecrets {
  const jwtPassphrase = urlSafeToken(24);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: options.jwtModulusLength ?? DEFAULT_JWT_MODULUS_LENGTH,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: jwtPassphrase },
  });
  return {
    appSecret: hexToken(32),
    databaseName: options.databaseName ?? DEFAULT_DATABASE_NAME,
    databaseUser: options.databaseUser ?? DEFAULT_DATABASE_USER,
    databasePassword: urlSafeToken(24),
    databaseRootPassword: urlSafeToken(24),
    redisPassword: urlSafeToken(24),
    mercureJwtSecret: hexToken(32),
    jwtPassphrase,
    jwtPrivateKeyPem: privateKey,
    jwtPublicKeyPem: publicKey,
    managerToken: urlSafeToken(32),
  };
}

/**
 * Fills an empty `managerToken` (secret set read back from a pre-token
 * install). Minting a fresh token is always safe: unlike DB credentials it
 * protects no persisted data — the backend simply starts accepting the
 * manager loop once its container is recreated with the new env.
 */
export function ensureManagerToken(secrets: InstanceSecrets): { secrets: InstanceSecrets; minted: boolean } {
  if (secrets.managerToken !== '') return { secrets, minted: false };
  return { secrets: { ...secrets, managerToken: urlSafeToken(32) }, minted: true };
}

/**
 * Returns a secret set with the operator-configured mailer DSN applied.
 * `undefined` keeps whatever the set already has; an empty string CLEARS the
 * override (back to the Mailpit/image default).
 */
export function withMailerDsn(secrets: InstanceSecrets, mailerDsn: string | undefined): InstanceSecrets {
  if (mailerDsn === undefined) return secrets;
  if (mailerDsn === '') {
    const { mailerDsn: _cleared, ...rest } = secrets;
    return rest;
  }
  return { ...secrets, mailerDsn };
}

/**
 * Mailer DSN with any `user:password@` userinfo masked, safe for UI/CLI
 * display ("what is configured" without revealing SMTP credentials).
 *
 * Security: the userinfo must be matched up to the LAST `@` in the authority,
 * not the first. SMTP usernames are frequently email addresses
 * (`user@gmail.com:app-password@smtp.gmail.com:587`), so a naive "up to the
 * first @" redaction would leave the password in clear text. We isolate the
 * authority (everything between `scheme://` and the first `/`, `?` or `#`) and
 * replace its entire userinfo with `***`. A DSN without userinfo (e.g. a relay
 * that needs no authentication, `smtp://smtp.example.org:25`) is returned
 * unchanged — there is nothing secret to hide.
 */
export function redactMailerDsn(dsn: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(dsn);
  if (!scheme) return dsn;
  const prefix = scheme[0];
  const rest = dsn.slice(prefix.length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
  const lastAt = authority.lastIndexOf('@');
  if (lastAt === -1) return dsn;
  return `${prefix}***@${authority.slice(lastAt + 1)}${tail}`;
}

/** A clone always receives freshly generated secrets; the source's are never reused. */
export function generateCloneSecrets(options: GenerateSecretsOptions = {}): InstanceSecrets {
  return generateInstanceSecrets(options);
}

export type RestoreSecretMode = 'same_instance' | 'restore_as_clone';

/**
 * Restore secret policy: an in-place same-instance restore keeps the existing
 * secrets (the data they protect is unchanged); a restore-as-clone is a new
 * security boundary and MUST get fresh secrets.
 */
export function secretsForRestore(
  mode: RestoreSecretMode,
  existing: InstanceSecrets | undefined,
  options: GenerateSecretsOptions = {},
): { secrets: InstanceSecrets; regenerated: boolean } {
  if (mode === 'same_instance') {
    if (!existing) {
      throw new Error('same_instance restore requires the existing instance secrets to preserve.');
    }
    return { secrets: existing, regenerated: false };
  }
  return { secrets: generateInstanceSecrets(options), regenerated: true };
}

/** Secret env vars consumed by backend/worker/scheduler/db/redis/mercure containers. */
export function secretEnvMap(secrets: InstanceSecrets): Record<string, string> {
  const dbPassword = encodeURIComponent(secrets.databasePassword);
  const redisPassword = encodeURIComponent(secrets.redisPassword);
  return {
    APP_SECRET: secrets.appSecret,
    DATABASE_URL: `mysql://${secrets.databaseUser}:${dbPassword}@mysql:3306/${secrets.databaseName}?serverVersion=8.4&charset=utf8mb4`,
    MYSQL_DATABASE: secrets.databaseName,
    MYSQL_USER: secrets.databaseUser,
    MYSQL_PASSWORD: secrets.databasePassword,
    MYSQL_ROOT_PASSWORD: secrets.databaseRootPassword,
    REDIS_PASSWORD: secrets.redisPassword,
    // `default:` user so the support-bundle redactor (which keys on `user:pass@`) strips it.
    REDIS_URL: `redis://default:${redisPassword}@redis:6379`,
    MERCURE_JWT_SECRET: secrets.mercureJwtSecret,
    MERCURE_PUBLISHER_JWT_KEY: secrets.mercureJwtSecret,
    MERCURE_SUBSCRIBER_JWT_KEY: secrets.mercureJwtSecret,
    JWT_PASSPHRASE: secrets.jwtPassphrase,
    // Enables the backend's token-gated CMS<->Manager update loop
    // (SystemManagerController). Empty = loop disabled (backend default).
    SELFHELP_MANAGER_TOKEN: secrets.managerToken,
    // Operator SMTP override; loads after .env so it wins over the Mailpit
    // default. Absent when the instance uses local Mailpit / image default.
    ...(secrets.mailerDsn ? { MAILER_DSN: secrets.mailerDsn } : {}),
  };
}

export function renderSecretsEnv(secrets: InstanceSecrets): string {
  const header =
    '# Generated by SelfHelp Manager. SECRET runtime config (0600, per-instance).\n' +
    '# Never commit, log, copy, or include unredacted in a support bundle.\n';
  const lines = Object.entries(secretEnvMap(secrets)).map(([k, v]) => `${k}=${v}`);
  return header + lines.join('\n') + '\n';
}

export interface SecretFileSpec {
  relPath: string;
  contents: string;
  mode: number;
}

/** Every secret artifact to write under the instance `secrets/` directory. */
export function instanceSecretFiles(secrets: InstanceSecrets): SecretFileSpec[] {
  const f = (relPath: string, contents: string): SecretFileSpec => ({ relPath, contents, mode: SECRET_FILE_MODE });
  // Container-readable (see JWT_KEY_FILE_MODE): mounted into uid-33 services.
  const k = (relPath: string, contents: string): SecretFileSpec => ({ relPath, contents, mode: JWT_KEY_FILE_MODE });
  return [
    f('app_secret', `${secrets.appSecret}\n`),
    f('db_password', `${secrets.databasePassword}\n`),
    f('db_root_password', `${secrets.databaseRootPassword}\n`),
    f('redis_password', `${secrets.redisPassword}\n`),
    f('mercure_jwt_secret', `${secrets.mercureJwtSecret}\n`),
    f('jwt_passphrase', `${secrets.jwtPassphrase}\n`),
    k('jwt/private.pem', secrets.jwtPrivateKeyPem),
    k('jwt/public.pem', secrets.jwtPublicKeyPem),
    f('secrets.env', renderSecretsEnv(secrets)),
  ];
}

/**
 * Reads a previously written secret set back from `<secretsDir>`.
 *
 * Used when `instance install` re-runs over a partially installed instance
 * (e.g. the wizard's "Retry installation" after a failed provisioning): the
 * MySQL/Redis volumes were already initialised with the FIRST attempt's
 * credentials, so the retry must continue with the same set — regenerating
 * would lock the stack out of its own database. Returns `null` when no
 * complete set exists (fresh install).
 */
export async function readInstanceSecrets(secretsDir: string): Promise<InstanceSecrets | null> {
  const tryRead = (rel: string): Promise<string | null> =>
    readFile(path.join(secretsDir, rel), 'utf8').catch(() => null);
  const [envText, privatePem, publicPem] = await Promise.all([
    tryRead('secrets.env'),
    tryRead('jwt/private.pem'),
    tryRead('jwt/public.pem'),
  ]);
  if (envText === null || privatePem === null || publicPem === null) return null;

  const vars: Record<string, string> = {};
  for (const line of envText.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    vars[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const get = (key: string): string | null => {
    const value = vars[key];
    return value !== undefined && value !== '' ? value : null;
  };

  const appSecret = get('APP_SECRET');
  const databaseName = get('MYSQL_DATABASE');
  const databaseUser = get('MYSQL_USER');
  const databasePassword = get('MYSQL_PASSWORD');
  const databaseRootPassword = get('MYSQL_ROOT_PASSWORD');
  const redisPassword = get('REDIS_PASSWORD');
  const mercureJwtSecret = get('MERCURE_JWT_SECRET');
  const jwtPassphrase = get('JWT_PASSPHRASE');
  if (
    !appSecret || !databaseName || !databaseUser || !databasePassword ||
    !databaseRootPassword || !redisPassword || !mercureJwtSecret || !jwtPassphrase
  ) {
    return null;
  }

  return {
    appSecret,
    databaseName,
    databaseUser,
    databasePassword,
    databaseRootPassword,
    redisPassword,
    mercureJwtSecret,
    jwtPassphrase,
    jwtPrivateKeyPem: privatePem,
    jwtPublicKeyPem: publicPem,
    // Pre-token installs have no SELFHELP_MANAGER_TOKEN line; tolerate it
    // (empty = loop disabled) so retries/updates can backfill instead of
    // treating the whole set as incomplete.
    managerToken: get('SELFHELP_MANAGER_TOKEN') ?? '',
    // Optional operator SMTP override; preserved across retries/updates.
    ...(get('MAILER_DSN') ? { mailerDsn: get('MAILER_DSN')! } : {}),
  };
}

/**
 * Injected IO so secret writing is unit-testable on any OS (Windows cannot
 * assert POSIX permission bits; the real implementation enforces them).
 */
export interface SecretIO {
  ensureDir(dir: string, mode: number): Promise<void>;
  writeFile(file: string, contents: string, mode: number): Promise<void>;
}

export const nodeSecretIO: SecretIO = {
  async ensureDir(dir, mode) {
    await mkdir(dir, { recursive: true, mode });
    await chmod(dir, mode).catch(() => undefined);
  },
  async writeFile(file, contents, mode) {
    await writeFile(file, contents, { mode });
    await chmod(file, mode).catch(() => undefined);
  },
};

/** Writes every secret file under `<secretsDir>` with restrictive permissions. */
export async function writeInstanceSecrets(
  secretsDir: string,
  secrets: InstanceSecrets,
  io: SecretIO = nodeSecretIO,
): Promise<string[]> {
  await io.ensureDir(secretsDir, SECRET_DIR_MODE);
  // The jwt/ dir is the bind-mount source: uid 33 must be able to traverse it.
  await io.ensureDir(path.join(secretsDir, 'jwt'), JWT_KEY_DIR_MODE);
  const written: string[] = [];
  for (const spec of instanceSecretFiles(secrets)) {
    const abs = path.join(secretsDir, spec.relPath);
    await io.writeFile(abs, spec.contents, spec.mode);
    written.push(abs);
  }
  return written;
}
