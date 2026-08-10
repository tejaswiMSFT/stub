/**
 * Runs every fixture in tests/fixtures against the real pipeline.
 *
 * Each fixture is the text layout of an actual ticket, captured by tools/make-fixture.mjs
 * and stripped of identifying values. Adding a new one requires no code here: drop the
 * file in, state what it should produce, and it is tested from then on.
 *
 * These exist because invented test data is written by the same person who wrote the
 * parser, and therefore tests only the cases they already thought of. Every genuine bug
 * so far — a timezone abbreviation read as a bus operator, a barcode seat field decoding
 * to a plausible but fictitious "0Y", a section heading reported as the airline — came
 * from a real document and none of them was imaginable in advance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { buildLines } from '../js/text.js';
import { extract } from '../js/adapters/index.js';

const dir = new URL('./fixtures/', import.meta.url);

let files = [];
try {
  files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
} catch {
  // No fixtures yet.
}

if (!files.length) {
  test('ticket fixtures', { skip: 'no fixtures in tests/fixtures yet' }, () => {});
}

for (const file of files) {
  const fixture = JSON.parse(await readFile(new URL(file, dir), 'utf8'));

  test(`fixture: ${fixture.name}`, async (t) => {
    // Only the first page: the rest is terms and conditions, and the parser reads the
    // page it judges most likely to carry the ticket.
    const lines = buildLines(fixture.pages[0].items);

    const barcode = fixture.barcode
      ? { ...fixture.barcode, walletCompatible: true }
      : null;

    // Some fixtures exist to be refused. A document that is not a ticket must produce
    // no pass at all — never a plausible-looking one assembled from whatever numbers and
    // dates happened to be on the page.
    if (fixture.expect?.rejected) {
      await t.test('is refused rather than turned into a pass', async () => {
        await assert.rejects(
          () => extract({ lines, barcode, ingested: { kind: 'pdf-text' } }),
          /doesn't look like a ticket/i,
        );
      });
      return;
    }

    const draft = await extract({ lines, barcode, ingested: { kind: 'pdf-text' } });
    const expected = fixture.expect || {};

    await t.test('reaches the right adapter', () => {
      if (!expected.adapter) return;
      assert.equal(draft.adapter, expected.adapter,
        `a ticket sent to the wrong adapter cannot be read at all`);
      if (expected.type) assert.equal(draft.type, expected.type);
    });

    if (expected.fields) {
      for (const [key, want] of Object.entries(expected.fields)) {
        await t.test(`reads ${key}`, () => {
          const got = draft.value(key);
          if (want === null) {
            assert.ok(!got, `expected nothing for ${key}, got "${got}"`);
          } else {
            assert.equal(got, want);
          }
        });
      }
    }

    // Whatever else changes, a value that is wrong must never be presented as certain.
    await t.test('never claims certainty it has not earned', () => {
      for (const field of draft.list()) {
        if (field.confidence === 'high' && field.source === 'pdf-text' && !field.corroboratedBy) {
          assert.fail(`${field.key} claims high confidence from printed text alone`);
        }
      }
    });

    await t.test('every golden-rule field is marked critical', () => {
      if (!expected.critical) return;
      const critical = new Set(draft.criticalFields.map((f) => f.key));
      for (const key of expected.critical) {
        assert.ok(critical.has(key), `${key} is checked at the barrier and must be critical`);
      }
    });

    await t.test('does not invent values for fields it could not read', () => {
      for (const key of expected.absent || []) {
        assert.ok(!draft.value(key), `${key} is not on this ticket and must stay empty`);
      }
    });
  });
}
