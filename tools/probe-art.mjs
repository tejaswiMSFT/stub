/**
 * Renders every pass composition at the size the app actually draws it.
 *
 * Reading an SVG generator tells you nothing about whether the picture reads. This puts
 * all of them side by side, at the real aspect ratio, so a composition that turns to
 * mush or looks like a different one can be seen rather than argued about.
 *
 *   node tools/probe-art.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
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
const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 2 });
await page.goto(`${origin}/index.html`);
await page.waitForTimeout(400);

await page.evaluate(async (base) => {
  const { buildSvg, derivePalette } = await import(`${base}/js/artwork.js`);

  const kinds = ['flight', 'rail', 'bus', 'movie', 'concert', 'theatre', 'sport', 'conference', 'cafe', 'event'];

  document.body.innerHTML = `
    <div style="background:#0b0b14;padding:20px;font:13px system-ui;color:#aaa">
      ${kinds.map((kind) => {
        const palette = derivePalette({ category: kind, title: 'Sample' });
        const svg = buildSvg({ slot: 'strip', category: kind, palette, scrim: true })
          .replace('<svg ', '<svg preserveAspectRatio="xMidYMid slice" ');
        return `
          <div style="margin-bottom:14px">
            <div style="margin-bottom:5px;text-transform:uppercase;letter-spacing:.08em;font-size:10px">${kind}</div>
            <div style="height:118px;border-radius:16px;overflow:hidden;position:relative">${svg}</div>
          </div>`;
      }).join('')}
    </div>`;
}, origin);

await page.waitForTimeout(500);
await page.screenshot({ path: 'tools/_art.png', fullPage: true });
console.log('wrote tools/_art.png');

await browser.close();
server.close();
