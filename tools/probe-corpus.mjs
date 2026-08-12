/**
 * Runs a folder of tickets through the real app and reports what each one produced.
 *
 * One file at a time hides the pattern. A whole folder shows which fields fail across
 * every ticket — which is the difference between fixing a layout and fixing a rule.
 *
 * Nothing is typed in. probe-ui fills empty required fields so it can reach the pass
 * screen, which is right for that tool and wrong for this one: a field the app left
 * blank must be reported blank, not filled with the harness's own text.
 *
 *   node tools/probe-corpus.mjs "C:\path\to\folder"
 */

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve, join, basename } from 'node:path';
import { chromium } from 'playwright';

const folder = process.argv[2];
if (!folder) {
  console.error('usage: node tools/probe-corpus.mjs <folder>');
  process.exit(1);
}

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

const files = (await readdir(folder))
  .filter((name) => ['.pdf', '.png', '.jpg', '.jpeg'].includes(extname(name).toLowerCase()))
  .sort();

if (!files.length) {
  console.error(`no tickets in ${folder}`);
  process.exit(1);
}

let serving = null;

const server = createServer(async (request, response) => {
  try {
    if (request.url.startsWith('/__probe-file')) {
      response.writeHead(200, { 'content-type': TYPES[extname(serving).toLowerCase()] || 'application/octet-stream' });
      response.end(await readFile(serving));
      return;
    }
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
const rows = [];

for (const name of files) {
  serving = join(folder, name);

  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  await page.goto(`${origin}/index.html`);
  await page.waitForTimeout(400);

  try {
    await page.evaluate(async (file) => {
      const response = await fetch('/__probe-file');
      const blob = await response.blob();
      const dropped = new File([blob], file, { type: blob.type });
      const input = document.querySelector('input[type=file]');
      const transfer = new DataTransfer();
      transfer.items.add(dropped);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, name);

    // The review screen is the honest place to read from: it is what the app believed
    // before anybody corrected it.
    await page.waitForFunction(
      () => {
        const review = document.getElementById('screen-review');
        return review && !review.hidden && review.offsetParent !== null;
      },
      { timeout: 180000 },
    );
    await page.waitForTimeout(400);

    const read = await page.evaluate(() => {
      const fields = {};
      for (const wrap of document.querySelectorAll('.review-field, .field')) {
        const label = wrap.querySelector('label, .k, h3')?.textContent?.trim();
        const input = wrap.querySelector('input, textarea');
        if (label && input) fields[label.replace(/\s+/g, ' ')] = input.value;
      }
      return {
        fields,
        barcode: Boolean(document.querySelector('.review-barcode, [data-barcode]')),
        notice: document.querySelector('.review-note, .notice')?.textContent?.trim()?.slice(0, 90) || '',
      };
    });

    rows.push({ name, ...read });
  } catch (error) {
    rows.push({ name, fields: {}, error: String(error).split('\n')[0].slice(0, 90) });
  }

  await page.close();
}

await browser.close();
server.close();

// Every field any ticket produced, so a column that is empty everywhere is visible.
const columns = [...new Set(rows.flatMap((row) => Object.keys(row.fields || {})))];

for (const row of rows) {
  console.log(`\n── ${basename(row.name)}`);
  if (row.error) { console.log(`   ERROR ${row.error}`); continue; }
  for (const key of columns) {
    const value = row.fields[key];
    if (value === undefined) continue;
    console.log(`   ${value ? '   ' : '!! '}${key.padEnd(14)} ${value || '(blank)'}`);
  }
  if (row.notice) console.log(`   ~  ${row.notice}`);
}

console.log('\n── blank counts');
for (const key of columns) {
  const seen = rows.filter((row) => row.fields?.[key] !== undefined);
  const blank = seen.filter((row) => !row.fields[key]);
  console.log(`   ${String(blank.length).padStart(2)}/${seen.length} blank  ${key}`);
}
