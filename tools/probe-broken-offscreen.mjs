/**
 * Reproduces the iOS Safari failure by breaking OffscreenCanvas on purpose.
 *
 * iOS Safari can expose an `OffscreenCanvas` constructor whose 2D context is missing or
 * unusable. Neither Chromium nor desktop WebKit does this — Chromium's works, desktop
 * WebKit has none at all and quietly takes the DOM path — so the bug was invisible in
 * every browser available here while breaking every PDF on the one device that matters.
 *
 * This forges that condition and runs a real PDF through, locally.
 *
 *   node tools/probe-broken-offscreen.mjs <file.pdf>
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, basename } from 'node:path';
import { chromium } from 'playwright';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/probe-broken-offscreen.mjs <file.pdf>');
  process.exit(1);
}

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/__probe-file') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
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
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });

// Before any of the app's code runs, replace OffscreenCanvas with one that exists but
// cannot do the job — exactly the shape of the iOS failure.
await context.addInitScript(() => {
  class BrokenOffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }

    // Present, but returns nothing usable — so every later call is "undefined is not a
    // function".
    getContext() {
      return null;
    }
  }
  window.OffscreenCanvas = BrokenOffscreenCanvas;
});

const page = await context.newPage();

const problems = [];
page.on('pageerror', (error) => problems.push(`${error.name}: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push('console: ' + message.text());
});

await page.goto(`${origin}/index.html`);
await page.waitForTimeout(1200);

await page.evaluate(async ([base, name]) => {
  const blob = await (await fetch(`${base}/__probe-file`)).blob();
  const input = document.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], name, { type: 'application/pdf' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, [origin, basename(file)]);

await page.waitForTimeout(12000);

const state = await page.evaluate(() => {
  const visible = (node) => node && !node.hidden && node.offsetParent !== null;
  return {
    screen: [...document.querySelectorAll('.screen')].find(visible)?.id,
    toast: document.querySelector('.toast:not([hidden])')?.innerText?.replace(/\s+/g, ' ').trim() || null,
    body: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200),
  };
});

console.log(JSON.stringify(state, null, 1));
console.log(state.screen === 'screen-review'
  ? '\nPASS — the PDF was read despite a broken OffscreenCanvas'
  : '\nFAIL — this is the iOS bug, still present');

if (problems.length) console.log('\nerrors:\n  ' + problems.join('\n  '));

await browser.close();
server.close();
