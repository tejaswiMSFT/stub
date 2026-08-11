/**
 * Times each stage of ingest separately.
 *
 * A cinema ticket took 136 seconds end to end, and the obvious culprit was OCR — except
 * OCR turns out to take one to three seconds. Guessing which stage is slow is how an
 * afternoon disappears; this measures each one.
 *
 *   node tools/probe-stages.mjs <image> [...]
 */

import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { extname, resolve, basename, join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.gz': 'application/gzip',
  '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

const READABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf']);

async function collect(paths) {
  const found = [];
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) {
        if (READABLE.has(extname(entry).toLowerCase())) found.push(join(path, entry));
      }
    } else found.push(path);
  }
  return found;
}

const files = await collect(process.argv.slice(2));
if (!files.length) {
  console.error('usage: node tools/probe-stages.mjs <file-or-directory> [...]');
  process.exit(1);
}

let current = null;

const server = createServer(async (request, response) => {
  if (request.url.startsWith('/__file')) {
    response.writeHead(200, { 'content-type': TYPES[extname(current).toLowerCase()] || 'application/octet-stream' });
    response.end(await readFile(current));
    return;
  }
  const path = resolve(root, decodeURIComponent(request.url.split('?')[0].slice(1)) || 'index.html');
  try {
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((done) => server.listen(0, done));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${origin}/index.html`);

console.log('\nSeconds per stage.\n');

for (const file of files) {
  current = file;

  const result = await page.evaluate(async ({ base, name }) => {
    const blob = await (await fetch(`${base}/__file`)).blob();
    const file = new File([blob], name, { type: blob.type });

    const timings = {};
    const time = async (label, work) => {
      const started = performance.now();
      const value = await work();
      timings[label] = (performance.now() - started) / 1000;
      return value;
    };

    const { ingest } = await import('./js/ingest.js');
    const { readBarcodesFromSource } = await import('./js/barcode.js');
    const { buildLines, linesFromOcr } = await import('./js/text.js');
    const { extract } = await import('./js/adapters/index.js');

    try {
      const ingested = await time('ingest', () => ingest(file));

      const barcodes = await time('barcode', () => readBarcodesFromSource(ingested));

      let lines = [];
      if (ingested.textItems?.length) {
        lines = await time('lines', async () => buildLines(ingested.textItems));
      } else if (ingested.displayCanvas?.width) {
        const words = await time('ocr', async () => {
          const { readWords } = await import('./js/ocr.js');
          return readWords(ingested.displayCanvas);
        });
        if (words?.length) lines = linesFromOcr(words, { scale: 1 });
      }

      await time('extract', () => extract({ lines, barcode: barcodes.primary, ingested }));

      return {
        ok: true,
        timings,
        canvas: ingested.displayCanvas ? `${ingested.displayCanvas.width}x${ingested.displayCanvas.height}` : 'none',
        attempts: barcodes.searched,
      };
    } catch (error) {
      return { ok: false, error: error.message, timings };
    }
  }, { base: origin, name: basename(file) });

  console.log('─'.repeat(70));
  console.log(`${basename(file)}${result.canvas ? `   canvas ${result.canvas}` : ''}`);

  const total = Object.values(result.timings).reduce((sum, value) => sum + value, 0);
  for (const [stage, seconds] of Object.entries(result.timings)) {
    const share = total ? Math.round((seconds / total) * 100) : 0;
    const bar = '█'.repeat(Math.max(0, Math.round(share / 3)));
    console.log(`  ${stage.padEnd(9)} ${seconds.toFixed(1).padStart(6)}s  ${String(share).padStart(3)}%  ${bar}`);
  }
  console.log(`  ${'total'.padEnd(9)} ${total.toFixed(1).padStart(6)}s`
    + (result.attempts ? `   (${result.attempts} barcode attempts)` : ''));

  if (!result.ok) console.log(`  REFUSED: ${result.error}`);
}

await browser.close();
server.close();
