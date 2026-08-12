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

/**
 * The ixigo traveller table, where the name sits in a column beside the PNR.
 *
 * A line's `text` has its column gaps collapsed to single spaces, so by the time the
 * title pattern reads it there is nothing to say where the name column ends. It reads up
 * to three more capitalised words after the honorific and walked straight into the next
 * cell: "Ganesan Natesan NTM" — the PNR NTM54A, clipped at the first digit because
 * digits are not in the name character class, so it did not even look wrong.
 *
 * The add-ons table below repeats the same two names against their sector, giving
 * "Ganesan Natesan MAA-HYD" — hyphens being legitimate in a surname. A booking for two
 * was reported as a booking for four, the extra two being the same people wearing a PNR
 * and a route.
 */
test('a name stops at its column', async (t) => {
  const ixigo = lines([
    [70, [[16, 'Booking Id:'], [16, 'IF23052734513934']]],
    [110, [[140, 'Barcode'], [330, 'Travellers'], [615, 'PNR'], [895, 'E-Ticket no.']]],
    [150, [[330, 'Mr. Ganesan Natesan'], [615, 'NTM54A'], [895, 'NTM54A']]],
    [190, [[330, 'Mr. R Sivaraman'], [615, 'NTM54A'], [895, 'NTM54A']]],
    [240, [[140, 'Travellers'], [470, 'Sector'], [620, 'Seat']]],
    [280, [[140, 'Mr. Ganesan Natesan'], [470, 'MAA-HYD'], [620, '18E']]],
    [320, [[140, 'Mr. R Sivaraman'], [470, 'MAA-HYD'], [620, '18F']]],
  ]);

  const draft = await flightAdapter.build({ lines: ixigo, barcode: null });
  const people = draft.passengers || [draft.value('passenger')];

  await t.test('does not weld the PNR onto the name', () => {
    for (const name of people) {
      assert.ok(!/NTM/.test(name), `"${name}" carries the PNR`);
    }
  });

  await t.test('does not weld the sector onto the name', () => {
    for (const name of people) {
      assert.ok(!/MAA|HYD/.test(name), `"${name}" carries the sector`);
    }
  });

  await t.test('counts the travellers, not the rows they appear in', () => {
    assert.equal(people.length, 2, `expected 2 travellers, got ${people.join(', ')}`);
  });
});
/**
 * The American Airlines e-ticket, where the caption and the name share a line.
 *
 * "PASSENGER NAME    ASHLEY/MARTELLE" is two columns of one printed line. Looking only
 * *beneath* the caption walked straight past the answer and kept going down the page
 * until it reached the airport table, and the pass named the traveller "SAN FRANCISCO
 * INTL" — twice, since the airport is printed for both departure and arrival.
 *
 * Shape cannot separate the two: an airport's name is a short capitalised phrase with no
 * digits, which is exactly what a name-finder is looking for.
 */
test('a caption beside its name', async (t) => {
  const american = lines([
    [40, [[16, 'e-Ticket Receipt & Itinerary']]],
    [90, [[16, 'PASSENGER AND TICKET INFORMATION']]],
    [130, [[16, 'PASSENGER NAME'], [200, 'ASHLEY/MARTELLE'], [520, 'FREQUENT FLYER'], [700, 'EK217206592/BLUE']]],
    [160, [[16, 'E-TICKET NUMBER'], [200, '176 2143480036'], [520, 'BOOKING REFERENCE'], [700, 'HG6NWJ']]],
    [200, [[16, 'ISSUED BY/DATE'], [200, 'AGT 86491845 AE']]],
    [260, [[16, 'DEPARTURE']]],
    [300, [[16, 'FLIGHT'], [160, 'DEPART/ARRIVE'], [330, 'AIRPORT/TERMINAL']]],
    [330, [[16, 'AA 9279'], [160, '02 MAR 24'], [330, 'SAN FRANCISCO INTL']]],
    [360, [[16, 'CONFIRMED'], [160, '14:05'], [330, 'TERMINAL 2']]],
  ]);

  const draft = await flightAdapter.build({ lines: american, barcode: null });
  const people = draft.passengers || [draft.value('passenger')].filter(Boolean);

  await t.test('takes the name beside the caption', () => {
    assert.equal(draft.value('passenger'), 'ASHLEY/MARTELLE');
  });

  await t.test('does not take an airport as a traveller', () => {
    for (const name of people) {
      assert.ok(!/SAN FRANCISCO|INTL|TERMINAL/i.test(name), `"${name}" is an airport`);
    }
  });

  await t.test('does not invent a second traveller', () => {
    assert.equal(people.length, 1, `expected 1 traveller, got ${people.join(', ')}`);
  });
});