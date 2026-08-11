/**
 * Feeds an image with no text layer through the app, the way a screenshot arrives.
 *
 * The point is to see exactly what a user is told when a document has no text to read.
 * Four real tickets were reported as failing outright, and "no OCR" is the obvious
 * explanation — but three of the four carried barcodes, which should have been enough on
 * their own. This separates the two cases.
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
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

// Draw a boarding pass as a picture — real pixels, no text layer, exactly like a
// screenshot or a photograph of a printed ticket.
//
// Two versions: one plain, one carrying a real scannable barcode. Three of the four
// tickets reported as failing had barcodes, so the two cases have to be told apart —
// "no OCR" only explains the first.
const withCode = process.argv.includes('--barcode');

const painter = await browser.newPage({ viewport: { width: 900, height: 560 } });

// Served from the origin, so module imports resolve. `setContent` gives the page an
// about:blank origin where a module script silently never runs — which is why an earlier
// version of this probe produced an image with no barcode and "proved" a bug that was
// entirely my own.
await painter.goto(`${origin}/index.html`);

await painter.evaluate(async ({ code, want }) => {
  document.body.innerHTML = `<div style="background:#fff;padding:40px;font-family:Arial;color:#000">
    <h1 style="font-size:30px;margin:0 0 22px">BOARDING PASS</h1>
    <p style="font-size:17px;margin:6px 0">Passenger &nbsp; A TRAVELLER</p>
    <p style="font-size:17px;margin:6px 0">From &nbsp; BLR &nbsp;&nbsp; To &nbsp; IXE</p>
    <p style="font-size:17px;margin:6px 0">Flight &nbsp; 6E 5306 &nbsp;&nbsp; Seat &nbsp; 10F</p>
    <p style="font-size:17px;margin:6px 0">Date &nbsp; 16 Sep 2026 &nbsp;&nbsp; Departs &nbsp; 14:35</p>
    <p style="font-size:17px;margin:6px 0">PNR &nbsp; NC1FKG</p>
    <canvas id="code" style="margin-top:18px"></canvas>
  </div>`;
  document.documentElement.style.background = '#fff';

  if (!want) return;
  const bwip = await import('./vendor/bwip-js.mjs');
  bwip.toCanvas(document.getElementById('code'), {
    bcid: 'pdf417', text: code, scale: 3, height: 12, includetext: false,
  });
}, { code: 'M1TRAVELLER/A       ENC1FKG BLRIXE6E 5306 259Y010F0025 100', want: withCode });

await painter.waitForTimeout(800);

const drawn = await painter.locator('#code').evaluate((el) => el.width).catch(() => 0);
console.log(`testing an image ${withCode ? 'WITH' : 'WITHOUT'} a barcode (canvas ${drawn}px wide)\n`);
if (withCode && !drawn) throw new Error('the probe failed to draw a barcode — fix the probe, not the app');

await painter.screenshot({ path: 'tools/_ticket-image.png' });
await painter.close();

const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
const problems = [];
page.on('pageerror', (e) => problems.push(String(e)));

await page.goto(`${origin}/index.html`);
await page.locator('#open-anyway').click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(600);

await page.evaluate(async (base) => {
  const blob = await (await fetch(`${base}/tools/_ticket-image.png`)).blob();
  const input = document.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'ticket.png', { type: 'image/png' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, origin);

await page.waitForTimeout(7000);

const reachedReview = await page.locator('#screen-review:not([hidden])').count();
const onAdd = await page.locator('#screen-add:not([hidden])').count();

console.log(`reached review: ${Boolean(reachedReview)}`);
console.log(`bounced back to add: ${Boolean(onAdd)}`);

const toastText = (await page.locator('#toast').textContent().catch(() => '') || '').trim();
if (toastText) console.log(`told the user: "${toastText}"`);

if (reachedReview) {
  const warnings = await page.locator('#review-scroll .notice p').allTextContents().catch(() => []);
  console.log('warnings:', JSON.stringify(warnings));

  const values = await page.evaluate(() => {
    const draft = window.__draft;
    return draft ? Object.fromEntries(draft.list().map((f) => [f.key, f.value])) : null;
  }).catch(() => null);
  if (values) console.log('fields:', JSON.stringify(values));
}

await page.screenshot({ path: 'tools/_image-result.png' });

if (problems.length) console.log(`\nERRORS:\n${problems.join('\n')}`);

await browser.close();
server.close();
