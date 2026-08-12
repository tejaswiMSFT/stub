/**
 * Reports what the barcode search finds in every file in a folder.
 *
 * Distinct from probe-corpus, which reports the fields. The question here is narrower
 * and worth asking on its own: of the tickets that visibly carry a code, how many do we
 * actually read, which candidate found it, and how long did it take?
 *
 *   node tools/probe-codes.mjs "C:\path\to\folder"
 */

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve, join } from 'node:path';
import { chromium } from 'playwright';

const folder = process.argv[2];
if (!folder) {
  console.error('usage: node tools/probe-codes.mjs <folder>');
  process.exit(1);
}

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf',
};

const files = (await readdir(folder))
  .filter((name) => ['.pdf', '.png', '.jpg', '.jpeg'].includes(extname(name).toLowerCase()))
  .sort();

let serving = null;

const server = createServer(async (request, response) => {
  try {
    if (request.url.startsWith('/__probe-file')) {
      response.writeHead(200, { 'content-type': TYPES[extname(serving).toLowerCase()] || 'application/octet-stream' });
      response.end(await readFile(serving));
      return;
    }
    const path = resolve(root, decodeURIComponent(request.url.split('?')[0].slice(1)) || 'index.html');
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();

for (const name of files) {
  serving = join(folder, name);

  const page = await browser.newPage();
  await page.goto(`${origin}/index.html`);
  await page.waitForTimeout(300);

  const started = Date.now();

  const result = await page.evaluate(async (base) => {
    const { ingest } = await import(`${base}/js/ingest.js`);
    const { readBarcodesFromSource, keepBarcodeImage } = await import(`${base}/js/barcode.js`);

    const blob = await (await fetch('/__probe-file')).blob();
    const ingested = await ingest(new File([blob], 'ticket', { type: blob.type }));

    const found = await readBarcodesFromSource(ingested);
    const kept = await keepBarcodeImage(ingested).catch(() => null);

    // Which candidate answered, in the page's own coordinates. A barcode found on the
    // last tile of ten is a barcode we very nearly missed, and the region says whether
    // the ordering is wrong or the decode is simply hard.
    const winner = ingested.barcodeCandidates?.[found.searched - 1];
    const region = winner?.region
      ? `${Math.round(winner.region.x)},${Math.round(winner.region.y)} ${Math.round(winner.region.width)}x${Math.round(winner.region.height)}`
      : (winner?.wholePage ? 'whole page' : 'embedded');

    return {
      candidates: ingested.barcodeCandidates?.length || 0,
      searched: found.searched,
      format: found.primary?.format || null,
      length: found.primary?.text?.length || 0,
      page: `${ingested.barcodeCanvas?.width}x${ingested.barcodeCanvas?.height}`,
      region,
      unsupported: found.unsupported?.map((u) => u.format || 'unknown') || [],
      kept: kept ? `${kept.width}x${kept.height}` : null,
    };
  }, origin).catch((error) => ({ error: String(error).split('\n')[0].slice(0, 80) }));

  const took = Date.now() - started;
  await page.close();

  if (result.error) {
    console.log(`ERR   ${name}  ${result.error}`);
    continue;
  }

  const verdict = result.format
    ? `READ ${result.format}, ${result.length} bytes, after ${result.searched}/${result.candidates} candidates`
    : result.kept
      ? `IMAGE only, ${result.kept}`
      : 'none';

  console.log(`${result.format ? 'ok  ' : '--  '}  ${name.slice(-10).padEnd(12)} ${String(took).padStart(6)}ms  page ${String(result.page).padEnd(10)} ${verdict}`);
}

await browser.close();
server.close();
