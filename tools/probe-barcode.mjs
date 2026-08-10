/**
 * What the barcode reader actually sees in a document.
 *
 * Reports every candidate image found, whether each decoded, and what came back. Written
 * because airline PDFs carrying a perfectly good QR were being reported as having none,
 * and there was no way to tell whether the barcode was never found or found and not
 * understood — two different bugs with two different fixes.
 *
 *   node tools/probe-barcode.mjs <file>
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, basename } from 'node:path';
import { chromium } from 'playwright';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/probe-barcode.mjs <file>');
  process.exit(1);
}

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

const fileType = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/__probe-file') {
      response.writeHead(200, { 'content-type': fileType });
      response.end(await readFile(resolve(file)));
      return;
    }
    const path = resolve(root, decodeURIComponent(request.url.split('?')[0].slice(1)) || 'index.html');
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((done) => server.listen(0, done));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('page error:', error.message));

await page.goto(`${origin}/index.html`);

const result = await page.evaluate(async ([base, name, type]) => {
  const [{ ingest }, barcode] = await Promise.all([
    import(`${base}/js/ingest.js`),
    import(`${base}/js/barcode.js`),
  ]);

  const blob = await (await fetch(`${base}/__probe-file`)).blob();
  const ingested = await ingest(new File([blob], name, { type }));

  const candidates = (ingested.barcodeCandidates || []).map((candidate) => ({
    width: candidate.canvas?.width,
    height: candidate.canvas?.height,
    embedded: Boolean(candidate.native),
  }));

  // Try each candidate on its own, so a failure can be attributed.
  const perCandidate = [];
  for (const candidate of ingested.barcodeCandidates || []) {
    if (!candidate.canvas) continue;
    try {
      const { barcodes } = await barcode.readBarcodes(candidate.canvas);
      perCandidate.push({
        size: `${candidate.canvas.width}x${candidate.canvas.height}`,
        embedded: Boolean(candidate.native),
        decoded: barcodes.map((b) => `${b.format}: ${String(b.text).slice(0, 30)}`),
      });
    } catch (error) {
      perCandidate.push({ size: `${candidate.canvas.width}x${candidate.canvas.height}`, error: String(error) });
    }
  }

  const overall = await barcode.readBarcodesFromSource(ingested);

  // Keep the most barcode-shaped candidate as a picture, so it can be looked at.
  const square = (ingested.barcodeCandidates || [])
    .filter((c) => c.canvas && c.native)
    .sort((a, b) => {
      const squareness = (x) => Math.abs(1 - x.canvas.width / x.canvas.height);
      return squareness(a) - squareness(b);
    })[0];

  let preview = null;
  if (square?.canvas) {
    try {
      preview = square.canvas.convertToBlob
        ? await new Promise(async (resolve) => {
          const blob = await square.canvas.convertToBlob({ type: 'image/png' });
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        })
        : square.canvas.toDataURL('image/png');
    } catch {
      preview = null;
    }
  }

  return {
    kind: ingested.kind,
    candidates,
    perCandidate,
    found: overall.found,
    primary: overall.primary
      ? { format: overall.primary.format, text: String(overall.primary.text).slice(0, 60), bytes: overall.primary.bytes?.length }
      : null,
    preview,
  };
}, [origin, basename(file), fileType]);

const { preview, ...summary } = result;
console.log(JSON.stringify(summary, null, 1));

if (preview) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile('probe-barcode.png', Buffer.from(preview.split(',')[1], 'base64'));
  console.log('\nmost barcode-shaped candidate written to probe-barcode.png');
}

await browser.close();
server.close();
