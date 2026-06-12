// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { generateWrapperScript } from './wrapper.js';

describe('generateWrapperScript (powershell)', () => {
  const script = generateWrapperScript({ shell: 'powershell' });

  it('mounts the Docker socket and the state folder at /opt/selfhelp', () => {
    expect(script).toContain("'/var/run/docker.sock:/var/run/docker.sock'");
    expect(script).toContain('"${Root}:/opt/selfhelp"');
  });

  it('defaults the state folder to the directory containing the saved script', () => {
    expect(script).toContain('$Root = $PSScriptRoot');
  });

  it('publishes the GUI loopback-only and binds 0.0.0.0 inside the container for `web`', () => {
    expect(script).toContain('-p "127.0.0.1:${WebPort}:${WebPort}"');
    expect(script).toContain('web --host 0.0.0.0 --port $WebPort');
    expect(script).toContain('$WebPort = 8765');
  });

  it('names the containers after the manager (GUI fixed, CLI per-shell)', () => {
    expect(script).toContain('--name sh-manager-web');
    expect(script).toContain('--name "sh-manager-cli-$PID"');
  });

  it("strips a pasted leading 'sh-manager' token before the web detection", () => {
    expect(script).toContain("$CliArgs[0] -eq 'sh-manager'");
    expect(script.indexOf("-eq 'sh-manager'")).toBeLessThan(script.indexOf("-eq 'web'"));
  });

  it('uses the official image by default and forwards the exit code', () => {
    expect(script).toContain("'ghcr.io/humdek-unibe-ch/sh-manager:latest'");
    expect(script).toContain('exit $LASTEXITCODE');
  });

  it('bakes an explicit root with PowerShell-safe quoting', () => {
    const baked = generateWrapperScript({ shell: 'powershell', root: "D:\\self'help" });
    expect(baked).toContain("$Root = 'D:\\self''help'");
    expect(baked).not.toContain('$PSScriptRoot');
  });
});

describe('generateWrapperScript (bash)', () => {
  const script = generateWrapperScript({ shell: 'bash' });

  it('starts with a shebang and strict mode', () => {
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
  });

  it('defaults the state folder to the directory containing the saved script', () => {
    expect(script).toContain('ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
  });

  it('survives Git Bash path mangling (cygpath + MSYS_NO_PATHCONV)', () => {
    expect(script).toContain('cygpath -w');
    expect(script).toContain('export MSYS_NO_PATHCONV=1');
  });

  it('publishes the GUI loopback-only for `web` and passes everything else through', () => {
    expect(script).toContain('-p "127.0.0.1:${WEB_PORT}:${WEB_PORT}"');
    expect(script).toContain('web --host 0.0.0.0 --port "$WEB_PORT"');
    expect(script).toContain('exec docker "${DOCKER_ARGS[@]}" --name "sh-manager-cli-$$" "$IMAGE" "$@"');
  });

  it('names the containers after the manager (GUI fixed, CLI per-shell)', () => {
    expect(script).toContain('--name sh-manager-web');
    expect(script).toContain('--name "sh-manager-cli-$$"');
  });

  it("strips a pasted leading 'sh-manager' token before the web detection", () => {
    expect(script).toContain(`if [ "\${1:-}" = 'sh-manager' ]; then shift; fi`);
    expect(script.indexOf("= 'sh-manager' ]")).toBeLessThan(script.indexOf("= 'web' ]"));
  });

  it('bakes an explicit root with shell-safe quoting', () => {
    const baked = generateWrapperScript({ shell: 'bash', root: "/srv/self'help" });
    expect(baked).toContain(`ROOT='/srv/self'\\''help'`);
  });
});

describe('generateWrapperScript (options)', () => {
  it('honours a custom image and web port', () => {
    const script = generateWrapperScript({ shell: 'powershell', image: 'ghcr.io/x/y:v9', webPort: 9000 });
    expect(script).toContain("'ghcr.io/x/y:v9'");
    expect(script).toContain('$WebPort = 9000');
  });

  it('rejects an unknown shell and an invalid port', () => {
    expect(() => generateWrapperScript({ shell: 'fish' as never })).toThrow(/powershell or bash/);
    expect(() => generateWrapperScript({ shell: 'bash', webPort: 0 })).toThrow(/Invalid web port/);
  });
});
