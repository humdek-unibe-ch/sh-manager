// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * File-backed operator store.
 *
 * Persists the {@link OperatorTable} as a single `0600` JSON file under a
 * `0700` directory (mirrors the per-instance secret-file convention). Writes
 * are atomic (tmp file + rename) so a crash mid-write cannot corrupt the
 * operator registry. The file holds scrypt password DIGESTS only — never raw
 * passwords or session secrets — and is therefore safe to persist on disk (but
 * it is NOT placed in `.env`, the manifest, the lock, or any support bundle).
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emptyOperatorTable, type OperatorStore, type OperatorTable } from './operators.js';

export const OPERATOR_FILE_MODE = 0o600;
export const OPERATOR_DIR_MODE = 0o700;

function isOperatorTable(value: unknown): value is OperatorTable {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Partial<OperatorTable>;
  // A legacy `allowedEmails` array (from the removed OIDC allowlist) is tolerated
  // on load — extra fields are simply ignored and dropped on the next save.
  return t.version === 1 && Array.isArray(t.operators);
}

export class FileOperatorStore implements OperatorStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<OperatorTable> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyOperatorTable();
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isOperatorTable(parsed)) {
      throw new Error(`Operator store at ${this.filePath} is malformed or has an unsupported version.`);
    }
    return parsed;
  }

  async save(table: OperatorTable): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: OPERATOR_DIR_MODE });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(table, null, 2)}\n`, { mode: OPERATOR_FILE_MODE });
    await chmod(tmp, OPERATOR_FILE_MODE);
    await rename(tmp, this.filePath);
    // Best-effort: enforce mode on the final path too (rename preserves it, but
    // a pre-existing file with looser perms would otherwise keep them).
    await chmod(this.filePath, OPERATOR_FILE_MODE);
  }
}

/** In-memory store for tests and ephemeral usage. */
export class InMemoryOperatorStore implements OperatorStore {
  private table: OperatorTable;

  constructor(initial: OperatorTable = emptyOperatorTable()) {
    this.table = initial;
  }

  load(): Promise<OperatorTable> {
    return Promise.resolve(this.table);
  }

  save(table: OperatorTable): Promise<void> {
    this.table = table;
    return Promise.resolve();
  }
}
