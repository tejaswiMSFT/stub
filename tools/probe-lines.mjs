/**
 * Prints the lines the app actually reads from a file, with their geometry.
 *
 * Every wrong guess I have made about extraction came from imagining the text rather
 * than looking at it — an arrow that OCR reads as a letter, a heading that is three
 * columns, a label welded to its neighbour. This shows what is really there.
 *
 *   node tools/probe-lines.mjs "C:\path\to\ticket.png" [count]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const file = process.argv[2];
const count = Number(process.argv[3] || 30);
if (!file) {
  console.error('usage: node tools/probe-lines.mjs <file> [count]');
  process.exit(1);
}

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (request, response) => {
  try {
    if (request.url.startsWith('/__probe-file')) {
      response.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
      response.end(await readFile(resolve(file)));
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
const page = await browser.newPage();
await page.goto(`${origin}/index.html`);
await page.waitForTimeout(400);

const lines = await page.evaluate(async ({ base, howMany }) => {
  const { ingest } = await import(`${base}/js/ingest.js`);
  const { buildLines, linesFromOcr, splitColumns } = await import(`${base}/js/text.js`);

  const blob = await (await fetch('/__probe-file')).blob();
  const ingested = await ingest(new File([blob], 'ticket', { type: blob.type }));

  let read = [];
  if (ingested.textItems?.length) {
    read = buildLines(ingested.textItems);
  } else if (ingested.displayCanvas?.width) {
    const { readWords } = await import(`${base}/js/ocr.js`);
    const words = await readWords(ingested.displayCanvas);
    read = linesFromOcr(words || [], { scale: 1 });
  }

  return read.slice(0, howMany).map((line) => ({
    text: line.text,
    height: Math.round((line.height || 0) * 10) / 10,
    y: Math.round(line.y || 0),
    columns: splitColumns(line).map((c) => c.text),
  }));
}, { base: origin, howMany: count });

const tallest = Math.max(...lines.map((l) => l.height), 0);
for (const [index, line] of lines.entries()) {
  const big = line.height >= tallest * 0.8 ? '*' : ' ';
  console.log(`${String(index).padStart(3)}${big} h=${String(line.height).padStart(5)} y=${String(line.y).padStart(5)}  ${line.text}`);
  if (line.columns.length > 1) console.log(`      cols: ${line.columns.map((c) => `[${c}]`).join(' ')}`);
}

await browser.close();
server.close();
