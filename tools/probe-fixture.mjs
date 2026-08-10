/**
 * Prints every field a fixture produces, alongside what it is expected to produce.
 *
 * A debugging aid, not a test. The test suite reports the first difference per field;
 * this shows the whole picture at once, which is what you want when a new layout fails
 * in several places and the failures share one cause.
 *
 *   node tools/probe-fixture.mjs irctc-email
 */

import { readFile } from 'node:fs/promises';

import { buildLines } from '../js/text.js';
import { extract } from '../js/adapters/index.js';

const name = process.argv[2];
if (!name) {
  console.error('usage: node tools/probe-fixture.mjs <fixture-name>');
  process.exit(1);
}

const url = new URL(`../tests/fixtures/${name}.json`, import.meta.url);
const fixture = JSON.parse(await readFile(url, 'utf8'));

const lines = buildLines(fixture.pages[0].items);
const barcode = fixture.barcode ? { ...fixture.barcode, walletCompatible: true } : null;
const draft = await extract({ lines, barcode, ingested: { kind: 'pdf-text' } });

const expected = fixture.expect?.fields || {};

console.log(`adapter: ${draft.adapter}   type: ${draft.type}\n`);

const keys = new Set([...draft.list().map((f) => f.key), ...Object.keys(expected)]);

for (const key of [...keys].sort()) {
  const got = draft.value(key) ?? '';
  const want = expected[key];
  const field = draft.list().find((f) => f.key === key);

  const mark = want === undefined ? ' ' : got === want ? '✓' : '✗';
  const detail = want !== undefined && got !== want ? `   want: ${JSON.stringify(want)}` : '';
  const meta = field ? `[${field.confidence}${field.critical ? ', critical' : ''}]` : '';

  console.log(`${mark} ${key.padEnd(16)} ${JSON.stringify(got).padEnd(34)} ${meta}${detail}`);
}

const warnings = draft.list().flatMap((f) => (f.warnings || []).map((w) => `${f.key}: ${w.message || w}`));
if (warnings.length) console.log(`\nwarnings:\n  ${warnings.join('\n  ')}`);
