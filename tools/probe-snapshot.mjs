/**
 * Checks that a snapshot is captured, stored, and shown.
 *
 * Drives a real PDF through the whole app in a browser, because everything that matters
 * here is browser-side: canvas encoding, the size guard, IndexedDB round-tripping a data
 * URL, and the menu item appearing only when there is something to show.
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
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
  '.pdf': 'application/pdf',
};

/**
 * A minimal one-page PDF with a text layer.
 *
 * Written by hand rather than with a library: this needs to be a *real* PDF that pdf.js
 * will parse and render, and adding a dependency to test a rendering path would be a poor
 * trade. The offsets in the xref table are computed, not guessed.
 */
function makePdf() {
  const lines = [
    'BT /F1 22 Tf 60 720 Td (BOARDING PASS) Tj ET',
    'BT /F1 12 Tf 60 690 Td (Passenger  A TRAVELLER) Tj ET',
    'BT /F1 12 Tf 60 670 Td (From  BLR   To  IXE) Tj ET',
    'BT /F1 12 Tf 60 650 Td (Flight  6E 5306   Seat  10F) Tj ET',
    'BT /F1 12 Tf 60 630 Td (Date  16 Sep 2026   Departs  14:35) Tj ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

const pdf = makePdf();
await writeFile(resolve(root, 'tools/_probe.pdf'), pdf);

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
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });

const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(String(e)));

await page.goto(`${origin}/index.html`);
await page.locator('#open-anyway').click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(600);

// Feed the PDF through the app's own file input, exactly as a user would.
await page.evaluate(async (base) => {
  const blob = await (await fetch(`${base}/tools/_probe.pdf`)).blob();
  const input = document.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'boarding-pass.pdf', { type: 'application/pdf' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, origin);

await page.waitForTimeout(6000);

const onReview = await page.locator('#screen-review:not([hidden])').count();
console.log(`reached the review screen: ${Boolean(onReview)}`);

if (!onReview) {
  problems.push('the PDF never reached review');
} else {
  // Fill anything still demanding attention, so Save can be pressed. A required field
  // left blank — a title we could not read, typically — keeps Save disabled by design.
  //
  // Done in a loop because every confirmation re-renders the review screen, which
  // detaches the remaining buttons; clicking a collected list of them silently misses
  // all but the first.
  for (let pass = 0; pass < 12; pass += 1) {
    if (!await page.locator('#review-save').isDisabled()) break;

    for (const input of await page.locator('#review-scroll input[data-input]').all()) {
      const value = await input.inputValue().catch(() => 'x');
      if (!value) await input.fill('TEST').catch(() => {});
    }

    const confirm = page.locator('[data-confirm]').first();
    if (await confirm.count()) {
      await confirm.click().catch(() => {});
      await page.waitForTimeout(200);
      continue;
    }

    await page.waitForTimeout(200);
  }

  const disabled = await page.locator('#review-save').isDisabled();
  console.log(`save enabled: ${!disabled}`);

  if (disabled) {
    const outstanding = await page.locator('.review-group.urgent .field-label, .review-group.urgent label')
      .allTextContents().catch(() => []);
    problems.push(`save stayed disabled; outstanding: ${outstanding.join(', ') || 'unknown'}`);
  }

  await page.locator('#review-save').click({ timeout: 3000 }).catch((e) => problems.push(`save: ${e.message}`));
  await page.waitForTimeout(2500);
}

// The snapshot must have survived the round trip through IndexedDB.
const stored = await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const all = await store.all();
  return all.map((t) => ({
    id: t.id,
    hasSnapshot: Boolean(t.snapshot?.image),
    bytes: t.snapshot?.bytes || 0,
    width: t.snapshot?.width || 0,
    isJpeg: String(t.snapshot?.image || '').startsWith('data:image/jpeg'),
  }));
});

console.log('stored:', JSON.stringify(stored));

if (!stored.length) problems.push('nothing was saved');
else {
  const [first] = stored;
  if (!first.hasSnapshot) problems.push('no snapshot was captured');
  if (!first.isJpeg) problems.push('the snapshot is not a JPEG');
  if (first.bytes > 700 * 1024) problems.push(`snapshot too large: ${first.bytes} bytes`);
  console.log(`snapshot: ${Math.round(first.bytes / 1024)} KB, ${first.width}px wide`);
}

// The menu item must appear, and open something.
await page.locator('.card[data-ticket]').first().click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(800);
await page.locator('#pass-menu').click({ timeout: 3000 }).catch((e) => problems.push(`menu: ${e.message}`));
await page.waitForTimeout(500);

const hasItem = await page.locator('[data-act="original"]').count();
console.log(`"View original" offered: ${Boolean(hasItem)}`);
if (!hasItem) problems.push('the View original item did not appear');

if (hasItem) {
  await page.locator('[data-act="original"]').click();
  await page.waitForTimeout(700);

  const shown = await page.locator('.original-image').count();
  console.log(`the picture is shown: ${Boolean(shown)}`);
  if (!shown) problems.push('the original did not open');

  const painted = await page.locator('.original-image')
    .evaluate((el) => el.naturalWidth > 0).catch(() => false);
  console.log(`the image decoded: ${painted}`);
  if (!painted) problems.push('the stored image did not decode');

  await page.locator('.action-panel').screenshot({ path: 'tools/_original.png' }).catch(() => {});
}

console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nNo problems.');

await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
