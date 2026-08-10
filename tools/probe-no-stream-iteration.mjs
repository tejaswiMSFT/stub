/**
 * Reproduces Safari's missing `ReadableStream` async iteration.
 *
 * `for await (const chunk of stream)` is a Chrome and Firefox extension that WebKit
 * never shipped. pdf.js uses it inside `getTextContent()`, so on an iPhone every PDF
 * fails with "undefined is not a function (near '...t of e...')" — while working
 * perfectly in every browser available for testing here.
 *
 * This deletes the method from the prototype, which is precisely what Safari's absence
 * looks like to running code, then puts a real PDF through the app.
 *
 *   node tools/probe-no-stream-iteration.mjs <file.pdf>
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, basename } from 'node:path';
import { chromium } from 'playwright';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/probe-no-stream-iteration.mjs <file.pdf>');
  process.exit(1);
}

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
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

// Before any app code runs, make streams non-iterable — Safari's actual behaviour.
await context.addInitScript(() => {
  try {
    delete ReadableStream.prototype[Symbol.asyncIterator];
    delete ReadableStream.prototype.values;
  } catch {
    // Already absent.
  }
});

const page = await context.newPage();

const problems = [];
page.on('pageerror', (error) => problems.push(`${error.name}: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push('console: ' + message.text());
});

await page.goto(`${origin}/index.html`);
await page.waitForTimeout(1200);

const iterable = await page.evaluate(() => typeof ReadableStream.prototype[Symbol.asyncIterator]);
console.log(`ReadableStream async iteration: ${iterable === 'undefined' ? 'removed (as on Safari)' : 'still present — probe failed'}`);

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
    fields: [...document.querySelectorAll('.review-field, .field')].length,
  };
});

console.log(JSON.stringify(state, null, 1));
console.log(state.screen === 'screen-review'
  ? '\nPASS — the PDF was read without async stream iteration'
  : '\nFAIL — this is the iPhone bug, still present');

if (problems.length) console.log('\nerrors:\n  ' + problems.join('\n  '));

await browser.close();
server.close();
