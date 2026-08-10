/**
 * Tests for label matching.
 *
 * This is the layer every adapter depends on, so a fault here is not one bad field on
 * one ticket — it is every field on every ticket of that shape. The IRCTC failure that
 * prompted these tests was exactly that: a header row of labels with values aligned
 * beneath, where the matcher took the *next label* as the value and reported a booking
 * reference of "Train".
 *
 * The cases below are drawn from real documents rather than invented, because the
 * awkwardness of real tickets is the whole problem.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLines, findValueForLabel, splitColumns } from '../js/text.js';

/**
 * Builds text items the way pdf.js reports them: positioned words, no layout.
 *
 * `rows` is a list of [y, [[x, text], ...]] so tests can express column positions
 * directly, which is what the matcher actually reasons about.
 */
function items(rows, { height = 10, charWidth = 5.2 } = {}) {
  const out = [];
  for (const [y, cells] of rows) {
    for (const [x, text] of cells) {
      out.push({ text, x, y, width: text.length * charWidth, height });
    }
  }
  return out;
}

const lines = (rows, options) => buildLines(items(rows, options));

// ────────────────────────────── beside ──────────────────────────────

test('label beside its value', async (t) => {
  await t.test('reads a colon-separated pair', () => {
    const found = findValueForLabel(lines([[100, [[0, 'Seat: 14A']]]]), /\bseat\b/i);
    assert.equal(found.value, '14A');
    assert.equal(found.relation, 'beside');
  });

  await t.test('reads a space-separated pair', () => {
    const found = findValueForLabel(lines([[100, [[0, 'PNR'], [60, '1234567890']]]]), /\bPNR\b/i);
    assert.equal(found.value, '1234567890');
  });

  await t.test('stops at the next column rather than swallowing it', () => {
    // "Coach S7   Berth 42" — the value is S7, not "S7 Berth 42".
    const found = findValueForLabel(
      lines([[100, [[0, 'Coach'], [40, 'S7'], [140, 'Berth'], [180, '42']]]]),
      /\bcoach\b/i,
    );
    assert.equal(found.value, 'S7');
  });
});

// ────────────────────────────── the header-row case ──────────────────────────────

test('tabular layout — labels above their values', async (t) => {
  /**
   * The IRCTC shape, reduced to its essentials:
   *
   *   PNR            Train No./Name          Class
   *   1234567890     16540 / MAJN YPR EXP    3E
   *
   * Every label sits in a header row with its value directly beneath. Reading along the
   * header row yields the *next label*, which is what went wrong.
   */
  const table = lines([
    [100, [[0, 'PNR'], [200, 'Train No./Name'], [420, 'Class']]],
    [120, [[0, '1234567890'], [200, '16540 / MAJN YPR EXP'], [420, '3E']]],
  ]);

  await t.test('takes the value beneath, not the neighbouring label', () => {
    const found = findValueForLabel(table, /\bPNR\b/i);
    assert.equal(found.value, '1234567890', 'reading along the row gives "Train No./Name"');
    assert.equal(found.relation, 'below');
  });

  await t.test('works for a column in the middle', () => {
    const found = findValueForLabel(table, /\btrain\s*no\b/i);
    assert.equal(found.value, '16540 / MAJN YPR EXP');
  });

  await t.test('works for the last column', () => {
    const found = findValueForLabel(table, /\bclass\b/i);
    assert.equal(found.value, '3E');
  });

  await t.test('does not leak a value from an adjacent column', () => {
    const found = findValueForLabel(table, /\bclass\b/i);
    assert.ok(!found.value.includes('16540'), 'columns must not bleed into one another');
  });
});

test('the from/to header', async (t) => {
  // "Booked From        To" with two station names beneath, which is how IRCTC prints
  // the route. "From" must not resolve to "To".
  const route = lines([
    [100, [[0, 'Booked From'], [380, 'To']]],
    [125, [[0, 'MANGALURU JN (MAJN)'], [380, 'YESVANTPUR JN (YPR)']]],
  ]);

  await t.test('From takes the station beneath it', () => {
    const found = findValueForLabel(route, /\bfrom\b/i);
    assert.equal(found.value, 'MANGALURU JN (MAJN)');
  });

  await t.test('To takes its own station', () => {
    const found = findValueForLabel(route, /\bto\b/i);
    assert.equal(found.value, 'YESVANTPUR JN (YPR)');
  });
});

test('mixed layouts on one ticket', async (t) => {
  // Real tickets mix both forms freely: a header table at the top, labelled pairs below.
  const mixed = lines([
    [100, [[0, 'PNR'], [200, 'Train No.']]],
    [120, [[0, '1234567890'], [200, '16540']]],
    [160, [[0, 'Quota: GENERAL (GN)']]],
    [180, [[0, 'Distance'], [90, '413 KM']]],
  ]);

  await t.test('handles the table part', () => {
    assert.equal(findValueForLabel(mixed, /\bPNR\b/i).value, '1234567890');
  });

  await t.test('handles the colon pair', () => {
    assert.equal(findValueForLabel(mixed, /\bquota\b/i).value, 'GENERAL (GN)');
  });

  await t.test('handles the spaced pair', () => {
    assert.equal(findValueForLabel(mixed, /\bdistance\b/i).value, '413 KM');
  });
});

// ────────────────────────────── refusals ──────────────────────────────

test('refusing to guess', async (t) => {
  await t.test('returns nothing when the label is absent', () => {
    assert.equal(findValueForLabel(lines([[100, [[0, 'Seat 14A']]]]), /\bgate\b/i), null);
  });

  await t.test('returns nothing when a label has no value anywhere', () => {
    // A lone header with nothing beneath it. Better nothing than the next heading.
    const found = findValueForLabel(lines([
      [100, [[0, 'Gate']]],
      [400, [[0, 'Terms and conditions apply']]],
    ]), /\bgate\b/i);
    assert.equal(found, null, 'a value far below is not this label\'s value');
  });

  await t.test('does not treat a second label as a value', () => {
    const found = findValueForLabel(lines([
      [100, [[0, 'Departure'], [200, 'Arrival']]],
      [120, [[0, '07:00'], [200, '16:30']]],
    ]), /\bdeparture\b/i);
    assert.equal(found.value, '07:00');
  });
});

// ────────────────────────────── column splitting ──────────────────────────────

test('column splitting', async (t) => {
  await t.test('separates columns at wide gaps', () => {
    const [line] = lines([[100, [[0, 'PNR'], [200, 'Train'], [420, 'Class']]]]);
    const columns = splitColumns(line);
    assert.equal(columns.length, 3);
    assert.deepEqual(columns.map((c) => c.text), ['PNR', 'Train', 'Class']);
  });

  await t.test('keeps ordinary word spacing together', () => {
    const [line] = lines([[100, [[0, 'Train'], [32, 'No./Name']]]]);
    const columns = splitColumns(line);
    assert.equal(columns.length, 1, 'a normal space is not a column boundary');
  });

  await t.test('handles a single-item line', () => {
    const [line] = lines([[100, [[0, 'IRCTC']]]]);
    assert.equal(splitColumns(line).length, 1);
  });
});
