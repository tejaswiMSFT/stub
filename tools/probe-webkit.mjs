/**
 * Runs a document through the deployed app in **WebKit** — the engine Safari uses.
 *
 * Chromium has been lying to us by being more capable. Every browser probe so far ran on
 * Chromium, where the app works; on an iPhone it fails at the PDF. Safari is the target
 * platform for this app more than any other, so it needs testing on the engine people
 * actually hold.
 *
 *   node tools/probe-webkit.mjs <file> [url]
 */

import { webkit } from 'playwright';
import { basename, extname } from 'node:path';
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
const url = process.argv[3] || 'https://tejaswimsft.github.io/stub/';

if (!file) {
  console.error('usage: node tools/probe-webkit.mjs <file> [url]');
  process.exit(1);
}

const TYPES = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.eml': 'message/rfc822', '.html': 'text/html',
};

const browser = await webkit.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

const problems = [];
page.on('pageerror', (error) => problems.push(`${error.name}: ${error.message}\n${error.stack || ''}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push('console: ' + message.text());
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

// Past the landing page if one is shown.
await page.evaluate(() => {
  const skip = [...document.querySelectorAll('a, button')]
    .find((node) => /use it in the browser|continue|skip/i.test(node.textContent));
  skip?.click();
}).catch(() => {});

await page.waitForTimeout(1500);

const bytes = await readFile(file);
const name = basename(file);
const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';

// Hand the file to the app's own input, exactly as the share sheet or file picker would.
await page.evaluate(async ({ data, name, type }) => {
  const blob = new Blob([Uint8Array.from(data)], { type });
  const input = document.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], name, { type }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, { data: [...bytes], name, type });

await page.waitForTimeout(12000);

const state = await page.evaluate(() => {
  const visible = (node) => node && !node.hidden && node.offsetParent !== null;
  const screen = [...document.querySelectorAll('.screen')].find(visible)?.id;

  return {
    screen,
    toast: document.querySelector('.toast')?.innerText?.replace(/\s+/g, ' ').trim() || null,
    body: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300),
  };
});

console.log(JSON.stringify(state, null, 1));

if (problems.length) {
  console.log('\n─── errors ───');
  for (const problem of problems) console.log(problem + '\n');
} else {
  console.log('\nno errors');
}

await page.screenshot({ path: 'probe-webkit.png', fullPage: true });

await browser.close();
