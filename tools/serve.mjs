/**
 * Minimal static server for local development.
 *
 * Exists because the app is made of ES modules, which browsers refuse to load over
 * file:// — a cross-origin restriction that has nothing to do with the code being wrong.
 * Development only; the shipped site is plain static files with no server at all.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath handles the percent-encoding and drive-letter quirks that arise from
// reading `import.meta.url` directly — this project's own path contains a space.
const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2]) || 8731;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // normalize collapses any ../ before it can escape the project directory.
  const target = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => console.log(`Serving ${root} on http://localhost:${port}`));
