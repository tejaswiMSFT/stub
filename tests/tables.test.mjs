/**
 * Tests for reading real ticket tables.
 *
 * Built from the actual layout of an IRCTC reservation slip, because the passenger table
 * is where several golden-rule fields live and nowhere else: the coach and berth exist
 * only inside a status cell like "CNF/M1/17/LOWER". Reading it wrongly does not produce
 * a slightly worse pass — it produces one with no berth on it at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLines, readTable } from '../js/text.js';
import { readPassengerTable, parseStatusCell } from '../js/adapters/rail.js';

function items(rows, { height = 10, charWidth = 5.2 } = {}) {
  const out = [];
  for (const [y, cells] of rows) {
    for (const [x, text] of cells) out.push({ text, x, y, width: text.length * charWidth, height });
  }
  return out;
}

const lines = (rows) => buildLines(items(rows));

/** The passenger table as IRCTC actually positions it. */
const irctc = lines([
  [255, [[31, 'Passenger Details']]],
  [269, [[31, '# Name'], [159, 'Age'], [207, 'Gender'], [278, 'Booking Status'], [447, 'Current Status']]],
  [285, [[31, '1. SAMPLE R'], [159, '31'], [207, 'M'], [274, 'CNF/M1/17/LOWER'], [442, 'CNF/M1/17/LOWER']]],
]);

test('reading a table', async (t) => {
  await t.test('finds the header and the rows beneath it', () => {
    const table = readTable(irctc, {
      name: /^#?\s*name\b/i,
      age: /\bage\b/i,
      gender: /\bgender\b/i,
    }, { minMatch: 3 });

    assert.ok(table, 'a header with three captions should be recognised');
    assert.equal(table.rows.length, 1);
    assert.match(table.rows[0].name, /SAMPLE R/);
    assert.equal(table.rows[0].age, '31');
  });

  await t.test('ignores a line that merely mentions one caption', () => {
    const prose = lines([
      [100, [[0, 'Please write your name clearly on the form.']]],
      [120, [[0, 'Some other text entirely']]],
    ]);
    const table = readTable(prose, { name: /\bname\b/i, age: /\bage\b/i }, { minMatch: 2 });
    assert.equal(table, null, 'one caption in a sentence is not a table header');
  });

  await t.test('reads several rows', () => {
    const family = lines([
      [100, [[31, '# Name'], [159, 'Age'], [207, 'Gender']]],
      [116, [[31, '1. SAMPLE R'], [159, '31'], [207, 'M']]],
      [132, [[31, '2. PRIYA K'], [159, '29'], [207, 'F']]],
      [148, [[31, '3. ARUN C'], [159, '4'], [207, 'M']]],
    ]);
    const table = readTable(family, { name: /^#?\s*name\b/i, age: /\bage\b/i, gender: /\bgender\b/i }, { minMatch: 3 });
    assert.equal(table.rows.length, 3);
  });
});

test('the passenger table', async (t) => {
  await t.test('strips the row number from the name', () => {
    const table = readPassengerTable(irctc);
    assert.equal(table.rows[0].name, 'SAMPLE R', 'the number belongs to the table, not the passenger');
  });

  await t.test('captures the status cell', () => {
    const table = readPassengerTable(irctc);
    assert.match(table.rows[0].current || table.rows[0].booking, /CNF/);
  });
});

test('reading a status cell', async (t) => {
  await t.test('pulls coach, berth and position from CNF/M1/17/LOWER', () => {
    const parsed = parseStatusCell('CNF/M1/17/LOWER');
    assert.equal(parsed.status, 'CNF');
    assert.equal(parsed.coach, 'M1');
    assert.equal(parsed.berth, '17');
    assert.equal(parsed.position, 'LB');
    assert.equal(parsed.positionName, 'Lower');
  });

  await t.test('handles a side berth without confusing it for a lower', () => {
    const parsed = parseStatusCell('CNF/S7/42/SIDE LOWER');
    assert.equal(parsed.position, 'SL', 'SIDE LOWER must not match LOWER');
    assert.equal(parsed.positionName, 'Side lower');
  });

  await t.test('handles abbreviated positions', () => {
    assert.equal(parseStatusCell('CNF/B2/34/UB').position, 'UB');
  });

  await t.test('handles a waitlisted cell with no allocation', () => {
    const parsed = parseStatusCell('WL/12');
    assert.equal(parsed.status, 'WL');
    assert.equal(parsed.coach, null, 'a waitlisted passenger has no coach yet');
  });

  await t.test('returns nothing for an empty cell', () => {
    assert.equal(parseStatusCell(''), null);
    assert.equal(parseStatusCell('—'), null);
  });
});

test('an IRCTC slip end to end', async (t) => {
  // The whole ticket, reduced to the lines that carry the golden-rule fields.
  const slip = lines([
    [20, [[195, 'Electronic Reservation Slip (ERS)']]],
    [105, [[31, 'Booked From'], [400, 'To']]],
    [130, [[31, 'MANGALURU JN (MAJN)'], [400, 'YESVANTPUR JN (YPR)']]],
    [150, [[31, 'Start Date* 13-Sept-2026'], [200, 'Departure* 07:00 13-Sept-2026']]],
    [170, [[31, 'PNR'], [220, 'Train No./Name'], [420, 'Class']]],
    [195, [[31, '1234567890'], [220, '16540 / MAJN YPR EXP'], [420, 'THIRD AC ECONOMY']]],
    [255, [[31, 'Passenger Details']]],
    [269, [[31, '# Name'], [159, 'Age'], [207, 'Gender'], [278, 'Booking Status'], [447, 'Current Status']]],
    [285, [[31, '1. SAMPLE R'], [159, '31'], [207, 'M'], [274, 'CNF/M1/17/LOWER'], [442, 'CNF/M1/17/LOWER']]],
    [325, [[31, 'Transaction ID: 100006722504762']]],
    [495, [[16, 'IRCTC Convenience Fee is charged per e-ticket.']]],
  ]);

  const railAdapter = (await import('../js/adapters/rail.js')).default;
  const draft = await railAdapter.build({ lines: slip, barcode: null });

  await t.test('reads the booking reference, not a neighbouring label', () => {
    assert.equal(draft.value('pnr'), '1234567890');
  });

  await t.test('keeps both train number and name', () => {
    assert.match(draft.value('service'), /16540/);
    assert.match(draft.value('service'), /MAJN YPR EXP/, 'the name matters as much as the number');
  });

  await t.test('reads the route', () => {
    assert.equal(draft.value('origin'), 'MAJN');
    assert.equal(draft.value('destination'), 'YPR');
  });

  await t.test('reads the passenger from the table', () => {
    assert.equal(draft.value('passenger'), 'SAMPLE R');
  });

  await t.test('recovers coach and berth from the status cell', () => {
    assert.equal(draft.value('coach'), 'M1');
    assert.equal(draft.value('seat'), '17');
    assert.equal(draft.value('berthPosition'), 'Lower');
  });

  await t.test('names the operator rather than the class', () => {
    assert.equal(draft.value('provider'), 'IRCTC');
  });

  await t.test('marks the golden-rule fields critical', () => {
    const critical = new Set(draft.criticalFields.map((f) => f.key));
    for (const key of ['pnr', 'service', 'date', 'passenger', 'coach', 'seat']) {
      assert.ok(critical.has(key), `${key} is checked at the barrier and must be critical`);
    }
  });
});
