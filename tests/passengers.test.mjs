/**
 * Tests for reading traveller names.
 *
 * Airlines caption almost everything except the name, so this is guesswork by necessity
 * — and the case that matters most is a booking covering several people. Showing one
 * traveller while quietly discarding the rest gives the holder no way to notice anyone
 * is missing, and they find out at the desk with a queue behind them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLines } from '../js/text.js';
import flightAdapter from '../js/adapters/flight.js';

function items(rows, { height = 10, charWidth = 5.2 } = {}) {
  const out = [];
  for (const [y, cells] of rows) {
    for (const [x, text] of cells) out.push({ text, x, y, width: text.length * charWidth, height });
  }
  return out;
}

const lines = (rows) => buildLines(items(rows));

/** The IndiGo itinerary layout, reduced to what matters. */
function indigo(passengerRows) {
  return lines([
    [25, [[420, '*Date of booking 08 Aug 2026 07:14']]],
    [70, [[16, 'PNR/Booking Reference'], [246, 'QP4RT9'], [340, 'Confirmed']]],
    [110, [[16, 'Passenger Information']]],
    ...passengerRows,
    [160, [[46, 'Sector'], [412, 'Seat'], [780, '6E Add-ons']]],
    [180, [[46, 'BLR-IXE'], [412, '10F(Window)'], [780, 'Lite']]],
    [220, [[98, '6E 5306 (A320)'], [260, '16 Sep 2026']]],
    [370, [[46, '14:35 hrs, 16 Sep 2026'], [886, '15:35 hrs, 16 Sep 2026']]],
    [415, [[16, '*Booking date reflects in UTC (Coordinated Universal Time)']]],
  ]);
}

test('one passenger', async (t) => {
  const draft = await flightAdapter.build({
    lines: indigo([[140, [[46, 'Mr SAMPLE R Adult | Male |']]]]),
    barcode: null,
  });

  await t.test('finds a name that carries a title', () => {
    assert.equal(draft.value('passenger'), 'SAMPLE R');
  });

  await t.test('drops the honorific', () => {
    // A boarding pass is checked against a passport, which carries no honorific.
    assert.ok(!/^mr\b/i.test(draft.value('passenger')));
  });

  await t.test('does not mistake the heading for the name', () => {
    assert.ok(!/information/i.test(draft.value('passenger')));
  });

  await t.test('does not claim there are several', () => {
    assert.ok(!draft.passengers || draft.passengers.length <= 1);
  });
});

test('a family booking', async (t) => {
  const draft = await flightAdapter.build({
    lines: indigo([
      [140, [[46, 'Mr SAMPLE R Adult | Male |']]],
      [148, [[46, 'Mrs PRIYA K Adult | Female |']]],
      [156, [[46, 'Mstr ARUN C Child | Male |']]],
    ]),
    barcode: null,
  });

  await t.test('keeps every traveller', () => {
    assert.equal(draft.passengers.length, 3, 'nobody may be silently dropped');
    assert.deepEqual(draft.passengers, ['SAMPLE R', 'PRIYA K', 'ARUN C']);
  });

  await t.test('shows the first on the front of the pass', () => {
    assert.equal(draft.value('passenger'), 'SAMPLE R');
  });

  await t.test('says how many there are', () => {
    assert.match(draft.get('passenger').note, /3 passengers/);
  });

  await t.test('asks the user to check the list', () => {
    const issue = draft.get('passenger').issues.find((i) => i.code === 'multiple-passengers');
    assert.ok(issue, 'a multi-passenger booking is where a quiet omission costs most');
    assert.match(issue.message, /3 passengers/);
  });

  await t.test('does not duplicate a repeated name', () => {
    const unique = new Set(draft.passengers.map((n) => n.toUpperCase()));
    assert.equal(unique.size, draft.passengers.length);
  });
});

test('an unlabelled name', async (t) => {
  // Some itineraries print no title at all — just the name beneath the heading.
  const draft = await flightAdapter.build({
    lines: indigo([[140, [[46, 'SAMPLE CHANDRASHEKAR']]]]),
    barcode: null,
  });

  await t.test('takes the line beneath the heading', () => {
    assert.equal(draft.value('passenger'), 'SAMPLE CHANDRASHEKAR');
  });
});

test('refusing to guess a name', async (t) => {
  await t.test('leaves the field empty rather than inventing one', () => {
    const bare = lines([
      [70, [[16, 'PNR/Booking Reference'], [246, 'QP4RT9']]],
      [180, [[46, 'BLR-IXE'], [412, '10F']]],
      [220, [[98, '6E 5306'], [260, '16 Sep 2026']]],
    ]);

    return flightAdapter.build({ lines: bare, barcode: null }).then((draft) => {
      const value = draft.value('passenger');
      assert.ok(!value || value.length === 0, `expected no name, got "${value}"`);
      assert.ok(
        draft.get('passenger').needsReview,
        'a missing name must be asked for, since it is checked against ID',
      );
    });
  });

  await t.test('does not take a caption as a name', () => {
    const captions = lines([
      [110, [[16, 'Passenger Information']]],
      [130, [[46, 'Sector'], [412, 'Seat'], [780, 'Baggage']]],
      [150, [[46, 'BLR-IXE'], [412, '10F'], [780, '7KG']]],
    ]);

    return flightAdapter.build({ lines: captions, barcode: null }).then((draft) => {
      const value = draft.value('passenger') || '';
      for (const caption of ['sector', 'seat', 'baggage', 'information']) {
        assert.ok(!new RegExp(caption, 'i').test(value), `"${caption}" is a caption, not a passenger`);
      }
    });
  });
});
