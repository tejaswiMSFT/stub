/**
 * Proves the update mechanism works, by actually shipping a new version mid-session.
 *
 * Everything about updates is easy to get subtly wrong and impossible to notice: a
 * service worker that installs but never activates, a reload that fires while a ticket
 * is on screen, an "updated" notice on a first run. None of it shows up in a unit test,
 * because the behaviour lives in the browser's own lifecycle.
 *
 * So this serves the app from disk, lets it install, then changes a file and watches
 * what the app does.
 *
 *   node tools/probe-update.mjs
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

// Flipped partway through to simulate a deployment.
let pretendVersion = 'first';

const server = createServer(async (request, response) => {
  const path = decodeURIComponent(request.url.split('?')[0]);
  try {
    const file = resolve(root, path.slice(1) || 'index.html');
    let body = await readFile(file);

    // Change the service worker's cache name on the second round, which is exactly what
    // a real deployment does.
    if (path.endsWith('/sw.js') && pretendVersion === 'second') {
      body = Buffer.from(String(body).replace(/const VERSION = '[^']*';/, "const VERSION = 'second';"));
    }

    // And the build stamp, so the "you were updated" notice has something to compare
    // against — a real deploy changes both together.
    if (path.endsWith('/build.js') && pretendVersion === 'second') {
      body = Buffer.from(String(body).replace(/version: "[^"]*"/, 'version: "5 (newer)"'));
    }

    response.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((done) => server.listen(0, done));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

const toasts = [];
await page.exposeFunction('__recordToast', (text) => toasts.push(text));

await page.addInitScript(() => {
  // Record every toast the app raises, since they vanish on a timer.
  const seen = new Set();
  setInterval(() => {
    const node = document.querySelector('.toast:not([hidden])');
    if (!node) return;
    const text = node.innerText.replace(/\s+/g, ' ').trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      window.__recordToast?.(text);
    }
  }, 150);
});

console.log('— first visit —');
await page.goto(`${origin}/index.html`);
await page.waitForTimeout(3500);

const first = await page.evaluate(async () => {
  const registration = await navigator.serviceWorker.ready;
  return {
    controller: Boolean(navigator.serviceWorker.controller),
    caches: await caches.keys(),
    lastSeen: localStorage.getItem('stub:last-seen-build'),
  };
});
console.log(JSON.stringify(first, null, 1));
console.log(`toasts: ${JSON.stringify(toasts)}`);
console.log('(no "updated" notice on a first run is correct)\n');

// Deploy.
console.log('— deploying a new version —');
pretendVersion = 'second';
toasts.length = 0;

// A reload is the *expected* outcome here: the app applies the update itself when
// nothing is at stake. Watching for the navigation is how we know it worked, so it must
// be armed before the update is triggered rather than treated as a failure afterwards.
const navigated = page.waitForNavigation({ timeout: 20000 }).then(() => true).catch(() => false);

await page.evaluate(async () => {
  const registration = await navigator.serviceWorker.ready;
  await registration.update();
}).catch(() => {});

const reloaded = await navigated;
console.log(`app reloaded itself: ${reloaded}`);

await page.waitForTimeout(3000);
console.log(`toasts: ${JSON.stringify(toasts)}`);

const after = await page.evaluate(async () => ({
  caches: await caches.keys(),
  controller: Boolean(navigator.serviceWorker.controller),
  lastSeen: localStorage.getItem('stub:last-seen-build'),
})).catch(() => ({ caches: [], error: true }));

console.log(`caches now: ${JSON.stringify(after.caches)}`);

console.log(after.caches.includes('ticket-second')
  ? '\nPASS — the new version installed and took over with no user action'
  : '\nFAIL — the new version did not take over');

await browser.close();
server.close();
