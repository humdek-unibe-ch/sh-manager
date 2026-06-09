// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Tiny read-only static server for a built test registry directory. Returns a
 * `baseUrl` to hand to `instanceInstall({ registryUrl })`. Used by the e2e and
 * by the dummy-level rehearsal runbook.
 *
 * Usage (standalone):
 *   node e2e/serve-registry.mjs <registry-dir> [port]   # default port 8787
 */
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Start serving `dir`; `port` 0 picks a free port. Resolves to { url, port, close }. */
export function serveRegistry(dir, port = 0) {
  const rootDir = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const filePath = path.join(rootDir, path.normalize(urlPath));
    if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const st = statSync(filePath);
      if (st.isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': st.size });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${actualPort}/`,
        port: actualPort,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: node e2e/serve-registry.mjs <registry-dir> [port]\n');
    process.exit(1);
  }
  const port = Number(process.argv[3] ?? 8787);
  serveRegistry(dir, port).then(({ url }) => {
    process.stdout.write(`serving ${path.resolve(dir)} at ${url}\n`);
    process.stdout.write('press Ctrl+C to stop\n');
  });
}
