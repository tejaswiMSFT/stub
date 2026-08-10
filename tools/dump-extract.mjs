/**
 * Diagnostic: runs the real extraction pipeline over a PDF and reports what each
 * adapter field actually resolved to.
 *
 * The dump tool shows what is on the page; this shows what we made of it. The gap
 * between the two is the bug.
 */

import { readFile } from 'node:fs/promises';
import { buildLines } from '../js/text.js';
import { extract } from '../js/adapters/index.js';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/dump-extract.mjs <file>');
  process.exit(1);
}

const data = new Uint8Array(await readFile(path));
const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise;
const page = await doc.getPage(1);
const content = await page.getTextContent();
const viewport = page.getViewport({ scale: 1 });

// Shape the items the way ingest.js does before handing them to buildLines.
const items = content.items
  .filter((item) => item.str?.trim())
  .map((item) => ({
    text: item.str,
    x: item.transform[4],
    y: viewport.height - item.transform[5],
    width: item.width,
    height: item.height || Math.abs(item.transform[3]) || 10,
  }));

const lines = buildLines(items);
const draft = await extract({ lines, barcode: null, ingested: { kind: 'pdf-text' } });

console.log('adapter :', draft.adapter, '| type:', draft.type, '| score:', draft.adapterScore);
console.log('style   :', draft.style, '| transit:', draft.transitType);
console.log('');
console.log('field           value                                     source      conf     review');
console.log('-'.repeat(94));

for (const field of draft.list()) {
  console.log(
    field.key.padEnd(15),
    String(field.value || '—').slice(0, 40).padEnd(42),
    String(field.source).padEnd(11),
    String(field.confidence).padEnd(8),
    field.needsReview ? 'YES' : '',
  );
}

if (draft.warnings.length) {
  console.log('\nwarnings:');
  for (const warning of draft.warnings) console.log('  -', warning);
}

const issues = draft.list().flatMap((f) => f.issues.map((i) => `${f.key}: [${i.code}] ${i.message}`));
if (issues.length) {
  console.log('\nissues:');
  for (const issue of issues) console.log('  -', issue);
}
