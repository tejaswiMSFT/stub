/**
 * Measures the top bar on every screen.
 *
 * The bar was reported as "shrinking" when moving from the home screen to Add a ticket.
 * Reading the stylesheet does not settle it — the bars differ in what they contain (a
 * brand lockup on home, a 17px title elsewhere) and the height falls out of that, so it
 * has to be measured on the rendered page.
 *
 *   node tools/probe-bar.mjs
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

const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, decodeURIComponent(request.url.split('?')[0].slice(1)) || 'index.html');
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
await page.goto(`${origin}/index.html`);
await page.waitForTimeout(600);

const rows = await page.evaluate(() => {
  const out = [];
  for (const screen of document.querySelectorAll('section.screen')) {
    const bar = screen.querySelector('.bar');
    if (!bar) continue;

    // Every screen is measured in the same state — visible — rather than by revealing
    // them one at a time, which would let a transition mid-flight report a wrong height.
    const wasHidden = screen.hidden;
    screen.hidden = false;
    const box = bar.getBoundingClientRect();
    const brand = bar.querySelector('.bar-brand');
    const title = bar.querySelector('.bar-title');
    out.push({
      screen: screen.id,
      height: Math.round(box.height * 10) / 10,
      holds: brand ? 'brand' : (title ? 'title' : 'neither'),
      hasMark: Boolean(bar.querySelector('.bar-mark')),
    });
    screen.hidden = wasHidden;
  }
  return out;
});

const heights = [...new Set(rows.map((r) => r.height))];
for (const row of rows) {
  console.log(`${String(row.height).padStart(6)}px  ${row.holds.padEnd(8)} mark:${row.hasMark ? 'yes' : 'no '}  ${row.screen}`);
}
console.log(heights.length === 1
  ? `\nok    every bar is ${heights[0]}px`
  : `\nFAIL  bars differ: ${heights.sort((a, b) => a - b).join('px, ')}px`);

await browser.close();
server.close();
process.exit(heights.length === 1 ? 0 : 1);
