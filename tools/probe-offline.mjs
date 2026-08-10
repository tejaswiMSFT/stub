/**
 * Checks the app installs and works offline.
 *
 * The service worker names the files it caches by hand, and a hand-written list drifts
 * from reality the moment a file is added or renamed. A missing entry does not fail
 * loudly — the app simply breaks at the airport, which is the one place it must not.
 *
 *   node tools/probe-offline.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const requested = new Set();

const server = createServer(async (request, response) => {
  const path = decodeURIComponent(request.url.split('?')[0]);
  requested.add(path);
  try {
    const file = resolve(root, path.slice(1) || 'index.html');
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((done) => server.listen(0, done));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await context.newPage();

const problems = [];
page.on('pageerror', (error) => problems.push(String(error)));

await page.goto(`${origin}/index.html`);

// Wait for the service worker to take control and finish filling its cache.
const worker = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { error: 'no service worker support' };
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  if (!registration) return { error: 'service worker never became ready' };

  // Give the install handler time to populate the cache.
  await new Promise((done) => setTimeout(done, 3000));

  const names = await caches.keys();
  const cached = [];
  for (const name of names) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) cached.push(new URL(request.url).pathname);
  }

  return { scope: registration.scope, caches: names, cached: cached.sort() };
});

console.log('service worker: ' + JSON.stringify({ scope: worker.scope, caches: worker.caches }, null, 1));
console.log(`cached ${worker.cached?.length ?? 0} file(s)`);

// Anything the page actually asked for but the worker did not cache will be missing
// when the network is gone.
const missing = [...requested]
  .filter((path) => !path.startsWith('/__'))
  .filter((path) => !(worker.cached || []).includes(path));

if (missing.length) {
  console.log('\nrequested but NOT cached:');
  for (const path of missing.sort()) console.log('  ' + path);
} else {
  console.log('\nevery requested file is cached');
}

// Now the real test: cut the network and reload.
await context.setOffline(true);
const reloaded = await page.reload({ waitUntil: 'domcontentloaded' }).then(() => true).catch(() => false);

const offline = await page.evaluate(() => ({
  title: document.title,
  hasApp: Boolean(document.querySelector('#screen-home, #screen-landing, .screen')),
  visible: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
})).catch((error) => ({ error: String(error) }));

console.log('\noffline reload: ' + (reloaded ? 'loaded' : 'FAILED'));
console.log(JSON.stringify(offline, null, 1));

// The promise this app makes is not "the page loads offline" — it is "your ticket is
// there, with no signal". Anything less is decoration.
const withTicket = await page.evaluate(async () => {
  const store = await import('./js/store.js');

  await store.save({
    id: 'offline-trial',
    kind: 'rail',
    fields: { service: '16540 / SAMPLE EXP', pnr: '1234567890', origin: 'MAJN', destination: 'YPR', seat: '17' },
    provenance: {},
    barcode: { format: 'QRCode', text: 'OFFLINE-TRIAL', bytes: [79, 70, 70], isBinary: false },
    warnings: [],
    addedAt: Date.now(),
    updatedAt: Date.now(),
  });

  const all = await store.all();
  const found = all.find((record) => record.id === 'offline-trial');

  return {
    saved: Boolean(found),
    barcodeIntact: found?.barcode?.text === 'OFFLINE-TRIAL' && found?.barcode?.bytes?.length === 3,
  };
}).catch((error) => ({ error: String(error) }));

console.log('\nwith no network — a ticket saved and read back: ' + JSON.stringify(withTicket));

if (problems.length) console.log('\npage errors:\n  ' + problems.join('\n  '));

await browser.close();
server.close();
