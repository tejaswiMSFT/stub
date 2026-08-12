/**
 * A close look at the drawer, large enough to judge the icons.
 *
 * At 24px an icon either reads instantly or it does not, and that cannot be settled by
 * looking at the path data. A lifebelt drawn here read as a location target; only
 * rendering it showed that.
 *
 *   node tools/probe-drawer.mjs
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

for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({
    viewport: { width: 400, height: 700 },
    deviceScaleFactor: 4,
    colorScheme: theme,
  });
  await page.goto(`${origin}/index.html`);
  await page.waitForTimeout(900);
  await page.click('#open-anyway');
  await page.waitForTimeout(600);

  const drawer = await page.$('#drawer');
  await drawer.screenshot({ path: `tools/_drawer-${theme}.png` });
  await page.close();
}

console.log('wrote tools/_drawer-dark.png, _drawer-light.png');

await browser.close();
server.close();
