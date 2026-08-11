/**
 * Measures OCR: how long it takes at each size, and how much it reads.
 *
 * Both numbers together, because either alone is misleading. Halving the resolution
 * halves the time and would look like a win until you notice it stopped reading the
 * film's name. The point is to find the size where accuracy stops improving, not the
 * size where it gets fastest.
 *
 * Run against real photographs — cinema tickets took 98 to 158 seconds each, which is
 * unusable on a phone, and no synthetic test showed it.
 *
 *   node tools/probe-ocr-speed.mjs <image> [...]
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
  '.webmanifest': 'application/manifest+json',
};

const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

async function collect(paths) {
  const found = [];
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) {
        if (IMAGES.has(extname(entry).toLowerCase())) found.push(join(path, entry));
      }
    } else found.push(path);
  }
  return found;
}

const files = await collect(process.argv.slice(2));
if (!files.length) {
  console.error('usage: node tools/probe-ocr-speed.mjs <image-or-directory> [...]');
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

const SIZES = [900, 1200, 1600, 2000];

console.log('\nEach image at several working sizes. Words is how many the engine returned;');
console.log('confident is how many it scored above 70, which is the number that matters —');
console.log('a page of low-confidence guesses is worse than nothing.\n');

for (const file of files) {
  current = file;
  console.log('─'.repeat(70));
  console.log(basename(file));

  for (const edge of SIZES) {
    const result = await page.evaluate(async ({ base, maxEdge }) => {
      const blob = await (await fetch(`${base}/__file`)).blob();
      const bitmap = await createImageBitmap(blob);

      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();

      const { readWords } = await import('./js/ocr.js');

      const started = performance.now();
      const words = await readWords(canvas, { timeout: 240000 });
      const elapsed = performance.now() - started;

      const confident = (words || []).filter((w) => w.confidence >= 70);

      return {
        width: canvas.width,
        height: canvas.height,
        seconds: (elapsed / 1000).toFixed(1),
        words: words?.length || 0,
        confident: confident.length,
        // A sample, so a person can see whether the text is usable or mush.
        sample: confident.slice(0, 8).map((w) => w.text).join(' '),
      };
    }, { base: origin, maxEdge: edge });

    console.log(`  ${String(edge).padStart(4)}px  ${result.width}x${result.height}`
      + `  ${result.seconds.padStart(6)}s`
      + `  ${String(result.words).padStart(4)} words`
      + `  ${String(result.confident).padStart(4)} confident`);
    if (result.sample) console.log(`         "${result.sample}"`);
  }
}

await browser.close();
server.close();
