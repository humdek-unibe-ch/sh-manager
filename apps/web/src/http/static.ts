// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Static serving for the built React SPA (Vite `dist-web`). Resolves strictly
 * within the client directory (no path traversal), applies the correct content
 * type + cache policy, and falls back to a minimal shell when the assets are
 * missing (dev / a broken image).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, normalize, resolve } from 'node:path';

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Cache policy for a built SPA asset. Vite emits content-hashed files under
 * `assets/` (the hash changes whenever the bundle changes), so those are safe to
 * cache forever. The SPA shell (`index.html`) and any other unhashed top-level
 * file MUST be revalidated every load: otherwise a browser keeps the cached
 * shell pointing at the OLD bundle after a manager update, and the operator sees
 * the previous GUI version until a hard refresh (the "I updated but still see
 * the old GUI" report).
 */
function cacheControlForAsset(rel: string): string {
  const normalized = rel.replace(/\\/g, '/');
  if (normalized.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/**
 * Serve a file from the built SPA directory. Resolves within `clientDir` only
 * (no path traversal) and returns false when there is nothing to serve so the
 * caller can fall back to the inline shell or a 404.
 */
export async function serveStatic(clientDir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const rel = normalize(urlPath).replace(/^([\\/]|\.\.[\\/])+/, '');
  const full = resolve(clientDir, rel);
  if (full !== clientDir && !full.startsWith(clientDir + (process.platform === 'win32' ? '\\' : '/'))) return false;
  if (!existsSync(full)) return false;
  const body = await readFile(full);
  res.statusCode = 200;
  res.setHeader('Content-Type', STATIC_CONTENT_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', cacheControlForAsset(rel));
  res.end(body);
  return true;
}

/** Minimal page served when the built SPA is missing (dev / broken image). */
const FALLBACK_SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>SelfHelp Manager</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto;">
<h1>SelfHelp Manager</h1>
<p>The web console assets are not built. Run <code>npm run build</code> (or use the official
<code>sh-manager</code> Docker image) and reload this page.</p>
</body></html>`;

/** Serve the SPA shell (`index.html`) or the inline fallback when it is absent. */
export async function serveAppShell(clientDir: string | undefined, res: ServerResponse): Promise<void> {
  if (clientDir && (await serveStatic(clientDir, 'index.html', res))) return;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.statusCode = 200;
  res.end(FALLBACK_SHELL);
}
