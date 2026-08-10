/**
 * Diagnostic: dumps a PDF's text layer grouped into lines, the way text.js sees it.
 *
 * Exists because extraction failures are impossible to reason about from a rendered
 * page. A ticket that looks like a neat table on screen is very often a scatter of
 * absolutely-positioned fragments underneath, and the difference decides whether a
 * label sits beside its value or above it — which is precisely what label matching
 * depends on.
 *
 * Uses the legacy pdf.js build: the browser build assumes DOM APIs that Node lacks.
 */

import { readFile } from 'node:fs/promises';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/dump-pdf.mjs <file> [--raw]');
  process.exit(1);
}

const raw = process.argv.includes('--raw');
const data = new Uint8Array(await readFile(path));
const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise;

console.log('pages:', doc.numPages);

for (let n = 1; n <= Math.min(doc.numPages, 2); n++) {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });

  console.log(`\n===== page ${n} - ${Math.round(viewport.width)}x${Math.round(viewport.height)}, ${content.items.length} items =====\n`);

  if (raw) {
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      console.log(
        'x=' + String(Math.round(item.transform[4])).padStart(4),
        'y=' + String(Math.round(viewport.height - item.transform[5])).padStart(4),
        'w=' + String(Math.round(item.width)).padStart(4),
        JSON.stringify(item.str),
      );
    }
    continue;
  }

  const rows = new Map();
  for (const item of content.items) {
    if (!item.str?.trim()) continue;
    const y = Math.round(viewport.height - item.transform[5]);
    const key = Math.round(y / 5) * 5;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x: Math.round(item.transform[4]), w: item.width, text: item.str });
  }

  for (const key of [...rows.keys()].sort((a, b) => a - b)) {
    const line = rows.get(key).sort((a, b) => a.x - b.x);
    let out = '';
    let lastEnd = null;
    for (const part of line) {
      if (lastEnd !== null) {
        const gap = part.x - lastEnd;
        if (gap > 10) out += '  <' + Math.round(gap) + '>  ';
        else if (gap > 1) out += ' ';
      }
      out += part.text;
      lastEnd = part.x + (part.w || part.text.length * 5);
    }
    console.log(String(key).padStart(4), '|', out.trim());
  }
}
