/**
 * Walks a document through the whole app in a real browser and reports what the user
 * would see: the dashboard card, the pass face, and the back.
 *
 * Reading the rendering code is not the same as running it. This exercises the real
 * ingest → extract → store → render path, which is where a field that extracts perfectly
 * can still end up invisible.
 *
 *   node tools/probe-ui.mjs "C:\path\to\ticket.pdf"
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, basename } from 'node:path';
import { chromium } from 'playwright';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/probe-ui.mjs <file>');
  process.exit(1);
}

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/__probe-file') {
      response.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
      response.end(await readFile(resolve(file)));
      return;
    }
    const path = resolve(root, decodeURIComponent(request.url.split('?')[0].slice(1)) || 'index.html');
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
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text());
});
page.on('pageerror', (error) => problems.push(String(error)));

await page.goto(`${origin}/index.html`);

// Feed the file in the way the app expects: through its own file input.
await page.evaluate(async ([base, name]) => {
  const blob = await (await fetch(`${base}/__probe-file`)).blob();
  const input = document.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], name, { type: blob.type }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, [origin, basename(file)]);

// Wait for the app to leave the working screen.
await page.waitForFunction(
  () => !document.querySelector('#working')?.classList.contains('on')
    && !document.querySelector('#working[hidden]') === false,
  { timeout: 45000 },
).catch(() => {});

await page.waitForTimeout(2500);

const seen = await page.evaluate(() => {
  const visible = (element) => element && element.offsetParent !== null;
  const screen = [...document.querySelectorAll('section, .screen')]
    .find((node) => visible(node) && node.id)?.id;

  const text = (selector) => document.querySelector(selector)?.textContent?.trim() || null;

  const fields = [...document.querySelectorAll('.pass-field, .review-field, .field')]
    .map((node) => node.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return {
    screen,
    heading: text('#pass-title') || text('h1') || text('h2'),
    route: text('.pass-route') || text('.card-route'),
    fields: fields.slice(0, 30),
    toast: text('.toast'),
    body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600),
  };
});

console.log('REVIEW ' + JSON.stringify(seen, null, 1));

// Carry on: save it, return to the dashboard, and open the pass. A field that survives
// review can still vanish on the pass itself, which is the screen actually shown at a
// barrier.
const saved = await page.evaluate(async () => {
  // Type into anything still empty and required. The generic adapter deliberately leaves
  // the title blank for the user to supply, so this is the real path for a screenshot.
  for (const input of document.querySelectorAll('.review-field input, .field input')) {
    if (input.value) continue;
    input.value = input.type === 'date' ? '2026-09-16'
      : input.type === 'time' ? '11:15'
      : 'K.G.F. Chapter 2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((done) => setTimeout(done, 150));
  }

  // Confirm each uncertain field, which is what a user does before Save becomes
  // available. Re-queried each time because the list re-renders after every click.
  for (let round = 0; round < 20; round++) {
    const chip = document.querySelector('[data-confirm]');
    if (!chip) break;
    chip.click();
    await new Promise((done) => setTimeout(done, 120));
  }

  const button = document.querySelector('#review-save');
  if (!button) return { error: 'no save button' };
  if (button.disabled) {
    // Report precisely what is holding it up, since a field with no value shows no
    // "That's right" chip and cannot be confirmed away — it has to be typed.
    const blocking = [...document.querySelectorAll('.review-field, .field')]
      .map((node) => node.textContent.replace(/\s+/g, ' ').trim())
      .filter((line) => !/that's right|keep /i.test(line));
    return { error: 'save still disabled after confirming every field', blocking };
  }
  button.click();
  await new Promise((done) => setTimeout(done, 2000));

  const card = document.querySelector('[data-ticket]');
  if (!card) return { error: 'no card on the dashboard' };

  const cardText = card.textContent.replace(/\s+/g, ' ').trim();
  card.click();
  await new Promise((done) => setTimeout(done, 1200));

  const text = (selector) => document.querySelector(selector)?.textContent?.trim() || null;

  return {
    card: cardText,
    passTitle: text('#pass-title'),
    passRoute: document.querySelector('.pass-route')?.textContent.replace(/\s+/g, ' ').trim(),
    face: [...document.querySelectorAll('.pass-field')]
      .map((node) => node.textContent.replace(/\s+/g, ' ').trim()),
    // The barcode as it will actually be shown. This is the whole promise of the app:
    // whatever was scanned in must scan out identically.
    barcode: (() => {
      const stored = window.__probeTicket?.barcode;
      if (stored) return { format: stored.format, text: stored.text, bytes: stored.bytes?.length };
      return null;
    })(),
    canShowCode: Boolean(document.querySelector('#show-code')),
    back: [...document.querySelectorAll('.pass-scroll dl div, .pass-back-row, .back-row')]
      .map((node) => node.textContent.replace(/\s+/g, ' ').trim()).slice(0, 20),
  };
});

console.log('\nSAVED ' + JSON.stringify(saved, null, 1));

// Read the saved record back out of storage, not out of memory, so the check covers the
// round trip through localStorage that the barcode has to survive.
const stored = await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const all = await store.all();
  const record = all[0];
  if (!record) return null;
  return {
    kind: record.kind,
    barcode: record.barcode
      ? { format: record.barcode.format, text: record.barcode.text, byteLength: record.barcode.bytes?.length ?? null }
      : null,
  };
});

console.log('\nSTORED ' + JSON.stringify(stored, null, 1));

if (problems.length) console.log('\nconsole errors:\n  ' + problems.join('\n  '));

await page.screenshot({ path: `probe-${basename(file).replace(/\W+/g, '-')}.png`, fullPage: true });
console.log(`\nscreenshot: probe-${basename(file).replace(/\W+/g, '-')}.png (gitignored)`);

await browser.close();
server.close();
