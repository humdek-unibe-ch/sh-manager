// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileOperatorStore, InMemoryOperatorStore, OPERATOR_FILE_MODE } from './storage.js';
import { createOperator, emptyOperatorTable } from './operators.js';

const tempDirs: string[] = [];

async function makeTempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shm-operators-'));
  tempDirs.push(dir);
  return path.join(dir, 'nested', 'operators.json');
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('FileOperatorStore', () => {
  it('returns an empty table when the file does not exist', async () => {
    const store = new FileOperatorStore(await makeTempFile());
    const table = await store.load();
    expect(table.operators).toEqual([]);
    expect(table.version).toBe(1);
  });

  it('round-trips a saved table and creates the directory', async () => {
    const file = await makeTempFile();
    const store = new FileOperatorStore(file);
    const { table } = createOperator(emptyOperatorTable(), {
      email: 'owner@example.org',
      displayName: 'Owner',
      password: 'correct horse battery staple',
      roles: ['server_owner'],
    });
    await store.save(table);

    const reloaded = await store.load();
    expect(reloaded.operators).toHaveLength(1);
    expect(reloaded.operators[0]?.email).toBe('owner@example.org');

    // The persisted file must not contain the raw password.
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('correct horse battery staple');
    expect(OPERATOR_FILE_MODE).toBe(0o600);
  });

  it('throws on a malformed / unsupported-version store', async () => {
    const file = await makeTempFile();
    const badFile = path.join(path.dirname(path.dirname(file)), 'bad.json');
    await writeFile(badFile, JSON.stringify({ version: 99, operators: [] }));
    const store = new FileOperatorStore(badFile);
    await expect(store.load()).rejects.toThrow(/malformed|unsupported/i);
  });
});

describe('InMemoryOperatorStore', () => {
  it('persists across load/save in memory', async () => {
    const store = new InMemoryOperatorStore();
    expect((await store.load()).operators).toEqual([]);
    const { table } = createOperator(emptyOperatorTable(), {
      email: 'op@example.org',
      displayName: 'Op',
      password: 'correct horse battery staple',
      roles: ['read_only'],
    });
    await store.save(table);
    expect((await store.load()).operators).toHaveLength(1);
  });
});
