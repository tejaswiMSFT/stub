/**
 * Drives the home screen with seeded tickets and exercises the swipe gesture.
 *
 * The gesture is the kind of thing unit tests cannot reach â€” it depends on pointer
 * capture, real geometry, and a click that must be swallowed â€” so it is checked here, by
 * doing it. Every failure this probe has caught was invisible to the test suite.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
};

const server = createServer(async (request, response) => {
  const path = resolve(root, decodeURIComponent(request.url.split('?')[0].slice(1)) || 'index.html');
  try {
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream' });
    if (!TYPES[extname(path).toLowerCase()]) console.log(`  no mime: ${request.url}`);
    response.end(body);
  } catch (error) {
    console.log(`  404 ${request.url} -> ${path}`);
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((done) => server.listen(0, done));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 402, height: 874 }, hasTouch: true });

const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(String(e)));

await page.goto(`${origin}/index.html`);

// Seed straight into IndexedDB through the app's own store, so the records are exactly
// the shape the app writes.
await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const day = 86400000;

  const make = (id, kind, fields, extra = {}) => ({
    id, kind, fields, provenance: {}, warnings: [],
    barcode: { format: 'QR', text: 'TEST123', bytes: null, latin1: null, isBinary: false },
    departsAt: Date.now() + day * 3, addedAt: Date.now(), updatedAt: Date.now(),
    archived: false, ...extra,
  });

  await store.save(make('a', 'movie', { title: 'A Film With A Rather Long Name Indeed', reference: 'WK96NZZ' }));
  await store.save(make('b', 'rail', {
    provider: 'IRCTC', origin: 'MAJN', destination: 'YPR', service: '16540',
    date: '2026-09-13', departureTime: '07:00', coach: 'M1', seat: '17', berthPosition: 'Lower',
  }, { transitType: 'PKTransitTypeTrain', departsAt: Date.now() + day * 30 }));
  await store.save(make('c', 'flight', {
    provider: 'IndiGo', origin: 'BLR', destination: 'IXE', service: '6E 5306',
    date: '2026-09-16', departureTime: '14:35', seat: '10F',
  }, { transitType: 'PKTransitTypeAir', departsAt: Date.now() + day * 33 }));

  location.reload();
});

await page.waitForTimeout(1500);

// Get past the landing screen if it is showing.
await page.locator('#open-anyway').click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(600);

const count = await page.locator('.swipe').count();
console.log(`cards wrapped for swipe: ${count}`);
if (!count) { problems.push('no cards were wrapped'); }

await page.screenshot({ path: 'tools/_home.png' });

// â”€â”€ A vertical drag must scroll, not swipe â”€â”€
if (count) {
  const card = page.locator('.swipe .card').first();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2 - 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const stillThere = await page.locator('.swipe').count();
  console.log(`after a vertical drag, cards remaining: ${stillThere}`);
  if (stillThere !== count) problems.push('a vertical drag removed a card');

  // A vertical drag is a scroll, and a scroll does still deliver a click, so the pass may
  // now be open. Go back before the next gesture.
  await page.locator('#pass-back').click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(500);
}

// â”€â”€ A short horizontal drag must spring back and not open the pass â”€â”€
if (count) {
  const card = page.locator('.swipe .card').first();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const onPass = await page.locator('#screen-pass:not([hidden])').count();
  console.log(`after a short swipe, pass screen open: ${Boolean(onPass)}`);
  if (onPass) problems.push('a swipe opened the pass');
}

// â”€â”€ A full left swipe must delete, and offer undo â”€â”€
if (count) {
  const card = page.locator('.swipe .card').first();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(box.x + box.width / 2 - i * 16, box.y + box.height / 2);
  }
  await page.mouse.up();
  await page.waitForTimeout(900);

  const remaining = await page.locator('.swipe').count();
  const toastText = await page.locator('#toast:not([hidden])').textContent().catch(() => '');
  const toastAction = await page.locator('#toast:not([hidden])').getAttribute('data-action').catch(() => '');
  console.log(`after a full left swipe: ${remaining} cards, toast "${(toastText || '').trim()}" / "${toastAction || ''}"`);
  if (remaining >= count) problems.push('a full left swipe did not remove the card');
  if (!/undo/i.test(toastAction || '')) problems.push('no undo was offered after deleting');

  await page.screenshot({ path: 'tools/_after-swipe.png' });

  // ── Undo must bring the same pass back ──
  await page.locator('#toast').click();
  await page.waitForTimeout(700);
  const restored = await page.locator('.swipe').count();
  console.log(`after tapping undo: ${restored} cards`);
  if (restored !== count) problems.push('undo did not restore the deleted pass');
}

// ── Settings ──
await page.locator('#toast').evaluate((el) => { el.hidden = true; }).catch(() => {});
await page.locator('#open-settings').click({ timeout: 3000 }).catch((e) => problems.push(`settings: ${e.message}`));
await page.waitForTimeout(1500);
await page.locator('#screen-settings').screenshot({ path: 'tools/_settings.png' }).catch(() => {});
await page.locator('#settings-body').evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => {});
await page.waitForTimeout(1200);
await page.locator('#screen-settings').screenshot({ path: 'tools/_settings2.png' }).catch(() => {});

// â”€â”€ Settings â”€â”€
await page.locator('#toast').evaluate((el) => { el.hidden = true; }).catch(() => {});
await page.locator('#open-settings, [id*=settings]').first().click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'tools/_settings.png' });

console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nNo problems.');

await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);





