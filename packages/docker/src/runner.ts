// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Thin abstraction over `docker compose`. The decision logic lives in the
 * other packages and is tested without Docker; this is the side-effecting
 * boundary. Every invocation passes through {@link assertSafeComposeArgs}.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertSafeComposeArgs } from './guards.js';

const execFileAsync = promisify(execFile);

export interface ComposeResult {
  stdout: string;
  stderr: string;
}

export interface ComposeRunner {
  run(cwd: string, args: string[]): Promise<ComposeResult>;
}

/** Runs the real `docker compose` binary. */
export class RealComposeRunner implements ComposeRunner {
  async run(cwd: string, args: string[]): Promise<ComposeResult> {
    assertSafeComposeArgs(args);
    const { stdout, stderr } = await execFileAsync('docker', ['compose', ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr };
  }
}

/** Records invocations instead of executing them; used by tests and dry-runs. */
export class RecordingComposeRunner implements ComposeRunner {
  readonly calls: { cwd: string; args: string[] }[] = [];
  constructor(private readonly responder?: (args: string[]) => ComposeResult) {}
  async run(cwd: string, args: string[]): Promise<ComposeResult> {
    assertSafeComposeArgs(args);
    this.calls.push({ cwd, args });
    return this.responder?.(args) ?? { stdout: '', stderr: '' };
  }
}

export const composeCommands = {
  upDetached: (): string[] => ['up', '-d'],
  /** Note: never `-v`. Volumes (DB/uploads/plugins) must survive. */
  down: (): string[] => ['down'],
  /** Stop containers without removing them (used by the disable flow). */
  stop: (): string[] => ['stop'],
  restart: (): string[] => ['restart'],
  pull: (): string[] => ['pull'],
  /** Pull a single service's image (used by the frontend-only update). */
  pullService: (service: string): string[] => ['pull', service],
  /**
   * Recreate a single service without touching its dependencies. Used by the
   * frontend-only update to swap just the frontend container after its image
   * tag changed, leaving backend/worker/scheduler/db running untouched.
   */
  upService: (service: string): string[] => ['up', '-d', '--no-deps', service],
  ps: (): string[] => ['ps', '--format', 'json'],
  logs: (tail = 200): string[] => ['logs', '--no-color', `--tail=${tail}`],
} as const;
