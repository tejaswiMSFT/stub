/**
 * Runs a real image through the real pipeline, in a real browser.
 *
 * Images cannot be tested the way PDFs are: there is no text layer to capture, so a
 * fixture would be testing nothing. What matters for an image is what the barcode reader
 * and the adapters actually do with pixels, and that needs a browser — canvas,
 * createImageBitmap and the zxing wasm module all live there.
 *
 *   node tools/probe-image.mjs "C:\path\to\ticket.jpg"
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/probe-image.mjs <image>');
  process.exit(1);
}

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  try {
    // The image under test is served from outside the project root.
    if (request.url === '/__probe-image') {
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(await readFile(resolve(file)));
      return;
    }

    const path = resolve(root, decodeURIComponent(request.url.slice(1)) || 'index.html');
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
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

page.on('console', (message) => {
  if (message.type() === 'error') console.error('  browser error:', message.text());
});

await page.goto(`${origin}/index.html`);

const result = await page.evaluate(async (base) => {
  const [{ ingest }, barcode, { extract }, { buildLines }] = await Promise.all([
    import(`${base}/js/ingest.js`),
    import(`${base}/js/barcode.js`),
    import(`${base}/js/adapters/index.js`),
    import(`${base}/js/text.js`),
  ]);

  const blob = await (await fetch(`${base}/__probe-image`)).blob();
  const asFile = new File([blob], 'ticket.jpg', { type: 'image/jpeg' });

  const ingested = await ingest(asFile);
  const barcodes = await barcode.readBarcodesFromSource(ingested);

  const lines = ingested.textItems?.length ? buildLines(ingested.textItems) : [];

  let draft = null;
  let error = null;
  try {
    draft = await extract({ lines, barcode: barcodes.primary, ingested });
  } catch (thrown) {
    error = thrown.message;
  }

  return {
    kind: ingested.kind,
    needsOcr: ingested.needsOcr,
    textItems: ingested.textItems?.length || 0,
    ocrWords: ingested.ocrWords?.length || 0,
    lines: lines.length,
    barcode: barcodes.primary
      ? { format: barcodes.primary.format, text: barcodes.primary.text, bytes: barcodes.primary.bytes?.length }
      : null,
    unsupported: barcodes.unsupported?.map((b) => b.format) || [],
    error,
    adapter: draft?.adapter,
    type: draft?.type,
    fields: draft ? draft.list().map((f) => [f.key, f.value, f.confidence, f.source]) : [],
    warnings: draft?.warnings || [],
  };
}, origin);

console.log(JSON.stringify(result, null, 1));

await browser.close();
server.close();
