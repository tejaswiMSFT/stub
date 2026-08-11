/**
 * Drives the home screen with seeded tickets and exercises the swipe gesture.
 *
 * The gesture is the kind of thing unit tests cannot reach — it depends on pointer
 * capture, real geometry, a click that must be swallowed, and a card that must visibly
 * move — so it is checked here, by doing it.
 *
 * An earlier version of this probe checked only the *outcome* of each gesture: that a
 * card disappeared, that a toast appeared. Every one of those passed while the card was
 * not moving a single pixel, because a leftover `card-in` animation was holding
 * `transform: none` and quietly outranking the swipe's own transform. Hence the mid-drag
 * assertions below: what the user sees is the thing under test, not just what the store
 * ends up holding.
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
const page = await browser.newPage({ viewport: { width: 402, height: 874 }, hasTouch: true });

const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(String(e)));

await page.goto(`${origin}/index.html`);

// Seed straight through the app's own store, so the records are exactly the shape the
// app writes rather than a guess at it.
await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const day = 86400000;

  const make = (id, kind, fields, extra = {}) => ({
    id,
    kind,
    fields,
    provenance: {},
    warnings: [],
    barcode: { format: 'QR', text: 'TEST123', bytes: null, latin1: null, isBinary: false },
    departsAt: Date.now() + day * 3,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
    ...extra,
  });

  await store.save(make('a', 'movie', {
    title: 'A Film With A Rather Long Name Indeed', reference: 'WK96NZZ',
  }));

  await store.save(make('b', 'rail', {
    provider: 'IRCTC', origin: 'MAJN', destination: 'YPR', service: '16540',
    date: '2026-09-13', departureTime: '07:00', coach: 'M1', seat: '17', berthPosition: 'Lower',
  }, { transitType: 'PKTransitTypeTrain', departsAt: Date.now() + day * 30 }));

  await store.save(make('c', 'flight', {
    provider: 'IndiGo', origin: 'BLR', destination: 'IXE', service: '6E 5306',
    date: '2026-09-16', departureTime: '14:35', seat: '10F', gate: '12', terminal: '1',
  }, { transitType: 'PKTransitTypeAir', departsAt: Date.now() + day * 33 }));

  location.reload();
});

await page.waitForTimeout(1500);
await page.locator('#open-anyway').click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(900);

const count = await page.locator('.swipe').count();
console.log(`cards wrapped for swipe: ${count}`);
if (!count) problems.push('no cards were wrapped');

await page.screenshot({ path: 'tools/_home.png' });

// No action panel may be visible when nothing is being dragged. This is the red and
// green flash seen on every load: the cards fade in, and while they are transparent both
// panels show straight through them.
{
  const leaked = await page.evaluate(() => [...document.querySelectorAll('.swipe-action')]
    .filter((el) => Number(getComputedStyle(el).opacity) > 0.01).length);
  console.log(`action panels visible at rest: ${leaked}`);
  if (leaked) problems.push(`${leaked} action panels visible at rest — this is the red/green flash`);
}

// A vertical drag must scroll, not swipe.
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

  // A scroll still delivers a click, so the pass may now be open. Go back.
  await page.locator('#pass-back').click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(500);
}

// A short horizontal drag must visibly move the card, reveal the panel behind it, then
// spring back without opening the pass.
if (count) {
  const card = page.locator('.swipe .card').first();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2, { steps: 6 });

  const shift = await card.evaluate((el, x) => Math.round(el.getBoundingClientRect().x - x), box.x);
  console.log(`mid-drag the card has moved ${shift}px`);
  if (shift > -20) problems.push(`the card did not follow the pointer (moved ${shift}px)`);

  // The panel fades in over 120ms, so it is sampled after that rather than during it.
  await page.waitForTimeout(200);
  const panel = await page.locator('.swipe-action.delete').first()
    .evaluate((el) => getComputedStyle(el).opacity).catch(() => '0');
  console.log(`the delete panel is showing at opacity ${panel}`);
  if (Number(panel) < 0.9) problems.push('the delete panel did not appear behind the card');

  await page.screenshot({ path: 'tools/_mid-drag.png' });

  await page.mouse.up();
  await page.waitForTimeout(700);

  const home = await card.evaluate((el, x) => Math.round(el.getBoundingClientRect().x - x), box.x);
  console.log(`after release the card sits at ${home}px`);
  if (Math.abs(home) > 2) problems.push('the card did not spring back');

  const onPass = await page.locator('#screen-pass:not([hidden])').count();
  console.log(`after a short swipe, pass screen open: ${Boolean(onPass)}`);
  if (onPass) problems.push('a swipe opened the pass');
}

// A full left swipe must delete, with an undo.
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
  const action = await page.locator('#toast:not([hidden])').getAttribute('data-action').catch(() => '');
  console.log(`after a full left swipe: ${remaining} cards, toast action "${action || ''}"`);
  if (remaining >= count) problems.push('a full left swipe did not remove the card');
  if (!/undo/i.test(action || '')) problems.push('no undo was offered after deleting');

  await page.screenshot({ path: 'tools/_after-swipe.png' });

  // Undo must bring the same pass back.
  await page.locator('#toast').click();
  await page.waitForTimeout(800);
  const restored = await page.locator('.swipe').count();
  console.log(`after tapping undo: ${restored} cards`);
  if (restored !== count) problems.push('undo did not restore the deleted pass');
}

// A full right swipe must archive.
if (count) {
  await page.locator('#toast').evaluate((el) => { el.hidden = true; }).catch(() => {});
  const card = page.locator('.swipe .card').first();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(box.x + box.width / 2 + i * 16, box.y + box.height / 2);
  }
  await page.mouse.up();
  await page.waitForTimeout(900);

  const past = await page.locator('.past-block').count();
  console.log(`after a full right swipe, a Past section exists: ${Boolean(past)}`);
  if (!past) problems.push('archiving did not move the pass into Past');
}

// Settings.
await page.locator('#toast').evaluate((el) => { el.hidden = true; }).catch(() => {});
await page.locator('#open-settings').click({ timeout: 3000 }).catch((e) => problems.push(`settings: ${e.message}`));
await page.waitForTimeout(1500);
await page.locator('#screen-settings').screenshot({ path: 'tools/_settings.png' }).catch(() => {});
await page.locator('#settings-body').evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => {});
await page.waitForTimeout(1200);
await page.locator('#screen-settings').screenshot({ path: 'tools/_settings2.png' }).catch(() => {});

console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nNo problems.');

await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
