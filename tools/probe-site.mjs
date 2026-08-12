/**
 * Renders the site's Projects page and reports what is on it.
 *
 * Run from the ticket repo, which has Playwright installed, against the site repo's
 * files — the site has no build step and no dependencies of its own, and adding a
 * node_modules to it for one check would be worse than reaching across.
 *
 *   node tools/probe-site.mjs "C:\Users\tejaswic\site-repo"
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = process.argv[2];
if (!root) {
  console.error('usage: node tools/probe-site.mjs <site-repo>');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', (error) => errors.push(String(error).slice(0, 100)));

await page.goto(`${origin}/index.html`);
await page.waitForTimeout(1600);

const projects = await page.evaluate(() => [...document.querySelectorAll('.project')].map((node) => ({
  name: node.querySelector('.project-name')?.textContent.trim(),
  role: node.querySelector('.project-role')?.textContent.trim(),
  links: [...node.querySelectorAll('.project-links a')].map((a) => a.href),
})));

for (const project of projects) {
  console.log(`${project.name}  —  ${project.role}`);
  for (const link of project.links) console.log(`    ${link}`);
}

console.log(errors.length ? `\nERRORS: ${errors.join(' | ')}` : '\nno page errors');

// The Projects page is one panel of a paged layout. Navigating to it the way a reader
// does exercises the paging, rather than assuming a data attribute maps to a position.
//
// The whole viewport is captured rather than the panel element: the panels carry a
// continuous transition, so an element screenshot waits for a stability that never
// arrives and times out. The viewport is stable whether or not its contents are.
await page.goto(`${origin}/index.html#work`);
await page.waitForTimeout(2500);
await page.screenshot({ path: 'tools/_site-projects.png' });
console.log('wrote tools/_site-projects.png');

await browser.close();
server.close();
