/**
 * Drives real ticket files through the whole app and reports what it read.
 *
 * Every other test in this project uses text placed at coordinates I chose, which is a
 * weaker thing than it looks: my synthetic layouts are tidier than reality. Real PDFs
 * have overlapping text runs, ligatures, rotated cells, and text emitted in an order
 * that has nothing to do with reading order. The passenger-table bug earlier today was
 * hidden for exactly that reason — my harness collapsed the columns, and I briefly
 * blamed the app for a flaw in the test.
 *
 * So this takes actual files and puts them through the real pipeline in a real browser:
 * ingest, barcode, OCR where needed, adapter selection, extraction.
 *
 * Usage:
 *   node tools/probe-files.mjs <file-or-directory> [...]
 *
 * It asserts nothing. There is no correct answer to compare against for a file found on
 * the internet, and inventing one would encode my guesses as expectations. It prints what
 * was read so a person can look at the ticket and judge — which is the only honest way to
 * evaluate a document nobody has hand-labelled.
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, resolve, basename, join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.eml': 'message/rfc822',
  '.gz': 'application/gzip',
};

const TICKET_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.eml']);

/** Every file to try, expanding any directories given. */
async function collect(paths) {
  const found = [];

  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (!info) {
      console.log(`  (skipping ${path} — not found)`);
      continue;
    }

    if (info.isDirectory()) {
      for (const entry of await readdir(path)) {
        if (TICKET_EXTENSIONS.has(extname(entry).toLowerCase())) found.push(join(path, entry));
      }
    } else {
      found.push(path);
    }
  }

  return found;
}

const files = await collect(process.argv.slice(2));

if (!files.length) {
  console.error('usage: node tools/probe-files.mjs <file-or-directory> [...]');
  console.error('\nNo readable ticket files were given. Supported: .pdf .png .jpg .webp .gif .heic .eml');
  process.exit(1);
}

let current = null;

const server = createServer(async (request, response) => {
  // The file under test is served from a fixed path, so the page can fetch it without
  // knowing anything about the local filesystem.
  if (request.url.startsWith('/__file')) {
    response.writeHead(200, { 'content-type': TYPES[extname(current).toLowerCase()] || 'application/octet-stream' });
    response.end(await readFile(current));
    return;
  }

  const path = resolve(root, decodeURIComponent(request.url.split('?')[0].slice(1)) || 'index.html');
  try {
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((done) => server.listen(0, done));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();

console.log(`\nReading ${files.length} file${files.length === 1 ? '' : 's'} through the real pipeline.\n`);

const summary = [];

for (const file of files) {
  current = file;

  const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${origin}/index.html`);

  const started = Date.now();

  const result = await page.evaluate(async ({ base, name }) => {
    const blob = await (await fetch(`${base}/__file`)).blob();
    const file = new File([blob], name, { type: blob.type });

    const { ingest } = await import('./js/ingest.js');
    const { readBarcodesFromSource, formatLabel } = await import('./js/barcode.js');
    const { buildLines, linesFromOcr } = await import('./js/text.js');
    const { extract } = await import('./js/adapters/index.js');

    try {
      const ingested = await ingest(file);
      const barcodes = await readBarcodesFromSource(ingested);

      let lines = [];
      let usedOcr = false;

      if (ingested.textItems?.length) {
        lines = buildLines(ingested.textItems);
      } else if (ingested.displayCanvas?.width) {
        const { readWords } = await import('./js/ocr.js');
        const words = await readWords(ingested.displayCanvas);
        if (words?.length) {
          lines = linesFromOcr(words, { scale: 1 });
          usedOcr = true;
        }
      }

      const draft = await extract({ lines, barcode: barcodes.primary, ingested });

      const fields = {};
      for (const field of draft.list()) {
        if (field.value) fields[field.key] = field.value;
      }

      return {
        ok: true,
        kind: ingested.kind,
        pages: ingested.pageCount,
        lines: lines.length,
        usedOcr,
        barcode: barcodes.primary
          ? { format: formatLabel(barcodes.primary.format), bytes: barcodes.primary.bytes?.length || barcodes.primary.text?.length || 0 }
          : null,
        searched: barcodes.searched,
        type: draft.type,
        fields,
        needsReview: draft.fieldsNeedingReview.map((f) => f.key),
        warnings: draft.warnings,
      };
    } catch (error) {
      return { ok: false, error: error.message, hint: error.hint || null };
    }
  }, { base: origin, name: basename(file) });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('─'.repeat(74));
  console.log(`${basename(file)}   (${elapsed}s)`);

  if (!result.ok) {
    console.log(`  REFUSED: ${result.error}`);
    if (result.hint) console.log(`           ${result.hint}`);
    summary.push({ file: basename(file), outcome: 'refused' });
  } else {
    console.log(`  source: ${result.kind}, ${result.pages} page(s), ${result.lines} lines${result.usedOcr ? ' (via OCR)' : ''}`);
    console.log(`  barcode: ${result.barcode ? `${result.barcode.format}, ${result.barcode.bytes} bytes` : `none found (${result.searched} attempts)`}`);
    console.log(`  read as: ${result.type}`);

    for (const [key, value] of Object.entries(result.fields)) {
      const flag = result.needsReview.includes(key) ? ' ?' : '';
      console.log(`    ${key.padEnd(16)} ${JSON.stringify(value)}${flag}`);
    }

    for (const warning of result.warnings) console.log(`  ! ${warning}`);

    summary.push({
      file: basename(file),
      outcome: 'read',
      type: result.type,
      fields: Object.keys(result.fields).length,
      barcode: Boolean(result.barcode),
    });
  }

  if (errors.length) {
    console.log('  ERRORS:');
    for (const error of errors.slice(0, 3)) console.log(`    ${error.slice(0, 160)}`);
  }

  await page.close();
}

console.log(`\n${'═'.repeat(74)}`);
const refused = summary.filter((s) => s.outcome === 'refused').length;
const withCode = summary.filter((s) => s.barcode).length;
console.log(`${summary.length} files: ${summary.length - refused} read, ${refused} refused, ${withCode} had a readable barcode`);
console.log('\nNothing here is asserted. Look at each ticket and judge whether what was read');
console.log('is what it says — a file found on the internet has no correct answer to check.');

await browser.close();
server.close();
