/**
 * Shows what the app read from a file and why it decided what it decided.
 *
 * A refusal is the least informative thing the app can say, and "this doesn't look like
 * a ticket" tells the developer nothing at all. This prints the text as read and the
 * score each adapter gave it, which turns a refusal into a diagnosis.
 *
 *   node tools/probe-explain.mjs <file>
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, basename } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.gz': 'application/gzip',
  '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/probe-explain.mjs <file>');
  process.exit(1);
}

const server = createServer(async (request, response) => {
  if (request.url.startsWith('/__file')) {
    response.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
    response.end(await readFile(file));
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

const result = await page.evaluate(async ({ base, name }) => {
  const blob = await (await fetch(`${base}/__file`)).blob();
  const file = new File([blob], name, { type: blob.type });

  const { ingest } = await import('./js/ingest.js');
  const { buildLines, linesFromOcr } = await import('./js/text.js');
  const { readBarcodesFromSource } = await import('./js/barcode.js');

  const ingested = await ingest(file);
  const barcodes = await readBarcodesFromSource(ingested);

  let lines = [];
  let via = 'none';

  if (ingested.textItems?.length) {
    lines = buildLines(ingested.textItems);
    via = 'text layer';
  } else if (ingested.displayCanvas?.width) {
    const { readWords } = await import('./js/ocr.js');
    const words = await readWords(ingested.displayCanvas);
    if (words?.length) {
      lines = linesFromOcr(words, { scale: 1 });
      via = 'OCR';

      // Confidence matters as much as the words: a page of low-confidence guesses looks
      // like text and reads like noise.
      const confident = words.filter((w) => w.confidence >= 70).length;
      via += ` (${confident} of ${words.length} words confident)`;
    }
  }

  const context = { lines, barcode: barcodes.primary, ingested };
  const scores = {};

  for (const module of ['flight', 'rail', 'event', 'lodging', 'generic']) {
    try {
      const adapter = (await import(`./js/adapters/${module}.js`)).default;
      scores[module] = adapter?.detect ? adapter.detect(context) : null;
    } catch (error) {
      scores[module] = `error: ${error.message}`;
    }
  }

  return {
    kind: ingested.kind,
    canvas: ingested.displayCanvas ? `${ingested.displayCanvas.width}x${ingested.displayCanvas.height}` : null,
    via,
    barcode: barcodes.primary ? `${barcodes.primary.format}, ${barcodes.primary.text?.slice(0, 40) || ''}` : null,
    text: lines.map((l) => l.text).join('\n'),
    scores,
  };
}, { base: origin, name: basename(file) });

console.log(`\n${basename(file)}`);
console.log(`  source ${result.kind}${result.canvas ? `, canvas ${result.canvas}` : ''}`);
console.log(`  text via ${result.via}`);
console.log(`  barcode ${result.barcode || 'none'}`);

console.log('\n─── adapter scores (40 is the threshold) ───');
for (const [name, score] of Object.entries(result.scores)) {
  const verdict = typeof score === 'number' && score >= 40 ? '  ← accepts' : '';
  console.log(`  ${name.padEnd(10)} ${String(score).padStart(4)}${verdict}`);
}

console.log('\n─── text as read ───');
console.log(result.text || '  (nothing)');

await browser.close();
server.close();
