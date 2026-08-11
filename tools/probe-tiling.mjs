/**
 * Checks that a small barcode on a large page is actually found.
 *
 * The claim under test is that tiling rescues a code which a full-page decode loses.
 * That is easy to assert and easy to be wrong about, so this builds the failing case
 * deliberately: a QR occupying a few percent of an A4-sized page, exactly the proportion
 * a real ticket uses, and checks the payload comes back byte for byte.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

const server = createServer(async (request, response) => {
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
const page = await browser.newPage({ viewport: { width: 500, height: 900 } });

const problems = [];
page.on('pageerror', (e) => problems.push(String(e)));

await page.goto(`${origin}/index.html`);

const PAYLOAD = 'WK96NZZ';

const result = await page.evaluate(async ({ payload }) => {
  const bwip = await import('./vendor/bwip-js.mjs');
  const { readBarcodesFromSource } = await import('./js/barcode.js');
  const { tileCandidates } = await import('./js/tile.js');

  // An A4 page at a realistic render scale.
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = 1654;
  pageCanvas.height = 2339;
  const context = pageCanvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

  // Text, so the page is not a blank sheet with one mark on it.
  context.fillStyle = '#000';
  context.font = '34px Arial';
  context.fillText('BOARDING PASS', 120, 180);
  context.font = '22px Arial';
  context.fillText('Passenger   A TRAVELLER', 120, 240);
  context.fillText('From  BLR   To  IXE', 120, 280);
  context.fillText('Flight  6E 5306   Seat  10F', 120, 320);

  // The code, drawn small and low — where a ticket puts it.
  //
  // Scale 1 rather than 3, because at 3 the modules are wide enough that a full-page
  // decode succeeds and the test proves nothing. A real ticket's QR is printed at
  // whatever size the layout allows, and a phone screenshot or a downscaled render
  // shrinks it further; this is the marginal case tiling exists for.
  const code = document.createElement('canvas');
  bwip.toCanvas(code, { bcid: 'pdf417', text: payload, scale: 1, height: 8, includetext: false });
  context.drawImage(code, 1180, 1900);

  const share = ((code.width * code.height) / (pageCanvas.width * pageCanvas.height)) * 100;

  // First: the whole page, which is what the app did before tiling.
  const whole = await readBarcodesFromSource({
    barcodeCandidates: [{ canvas: pageCanvas, scale: 1, region: null }],
  });

  // Then: the whole page followed by tiles, which is what it does now.
  const tiled = await readBarcodesFromSource({
    barcodeCandidates: [
      { canvas: pageCanvas, scale: 1, region: null },
      ...tileCandidates(pageCanvas),
    ],
  });

  return {
    codeWidth: code.width,
    share: share.toFixed(2),
    wholePageFound: Boolean(whole.primary),
    wholePageText: whole.primary?.text || null,
    tiledFound: Boolean(tiled.primary),
    tiledText: tiled.primary?.text || null,
    searched: tiled.searched,
  };
}, { payload: PAYLOAD });

console.log(`code is ${result.codeWidth}px on a 1654x2339 page — ${result.share}% of it`);
console.log(`whole page alone:  ${result.wholePageFound ? `found ${JSON.stringify(result.wholePageText)}` : 'FOUND NOTHING'}`);
console.log(`with tiles:        ${result.tiledFound ? `found ${JSON.stringify(result.tiledText)}` : 'FOUND NOTHING'} (after ${result.searched} attempts)`);

if (!result.tiledFound) problems.push('tiling did not find the code');
if (result.tiledFound && result.tiledText !== PAYLOAD) {
  problems.push(`payload came back altered: ${result.tiledText}`);
}

console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nNo problems.');

await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
