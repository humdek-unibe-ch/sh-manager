// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Atomic file writes (tmp file + rename, with a `.bak` fallback). The
 * inventory, manifest and lock must never be left half-written.
 */
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeFileAtomic(
  filePath: string,
  contents: string,
  mode?: number,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
  try {
    await copyFile(filePath, `${filePath}.bak`, constants.COPYFILE_FICLONE).catch(() => undefined);
  } catch {
    // No prior file to back up; ignore.
  }
  await rename(tmp, filePath);
}

export async function writeJsonAtomic(filePath: string, value: unknown, mode?: number): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n', mode);
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}
