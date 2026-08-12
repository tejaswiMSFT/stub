/**
 * Regression tests built from real screenshots that failed.
 *
 * Every case here is a ticket Tejaswi fed to Stub that came out wrong, reduced to the
 * geometry that caused it. Fixing these one file at a time hid the pattern; measured
 * across a folder, the route was wrong or missing on every bus ticket in the corpus.
 *
 * The layouts are reconstructed from `tools/probe-lines.mjs` output — what OCR actually
 * returned, not what the ticket looks like to a person. That distinction is the whole
 * point: OCR does not preserve an arrow, and imagining that it does is what made the
 * first three attempts at this fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import railAdapter from '../js/adapters/rail.js';
import { buildLines } from '../js/text.js';

/** Positioned text runs, so column geometry is real rather than assumed. */
function items(rows, { charWidth = 5.2 } = {}) {
  const out = [];
  for (const [y, height, cells] of rows) {
    for (const [x, text] of cells) out.push({ text, x, y, width: text.length * charWidth, height });
  }
  return out;
}

const lines = (rows) => buildLines(items(rows));

const build = (rows) => railAdapter.build({ lines: lines(rows), barcode: null });

/*
 * redBus. OCR returns ">" for the arrow the designer set, and the date follows on the
 * same line — so the route cannot be anchored to the end of the line.
 *
 * "Boarding Point Ph. No.: 8724069239" also heads this ticket, and the origin pattern
 * matched the bare label, so the journey began at a telephone number.
 */
test('redBus: an arrow OCR read as a chevron', async (t) => {
  const draft = await build([
    [50, 30, [[16, 'Need help with your trip?']]],
    [90, 58, [[16, 'redBus'], [400, 'Boarding Point Ph. No.: 8724069239 /']]],
    [130, 36, [[600, 'Ticket no: TNAV59147881']]],
    [180, 59, [[16, 'Guwahati > Duliajan'], [400, 'Thursday, October 3, 2019']]],
    [240, 39, [[16, 'John Volvo-ASTC'], [300, '21:30'], [420, '21:45']]],
    [280, 25, [[16, 'Volvo A/C Seater'], [300, 'Reporting time'], [420, 'Departure time']]],
    [340, 30, [[16, 'Boarding point details'], [300, 'Khanapara']]],
    [400, 25, [[16, 'Passenger Details (Age, Gender)'], [400, 'Seat Number']]],
    [430, 30, [[16, 'Dilip Kumar Chetia (59, MALE)'], [400, '35']]],
  ]);

  await t.test('reads the journey from the heading', () => {
    assert.equal(draft.value('origin'), 'Guwahati');
    assert.equal(draft.value('destination'), 'Duliajan');
  });

  await t.test('does not begin the journey at a telephone number', () => {
    assert.ok(!/\d{7}/.test(draft.value('origin')), `origin is "${draft.value('origin')}"`);
  });

  await t.test('does not name the traveller after the column header', () => {
    // "Passenger Details (Age, Gender)" left "(Age, Gender)" once the label matched.
    assert.ok(!/\(age/i.test(draft.value('passenger') || ''), `passenger is "${draft.value('passenger')}"`);
  });

  await t.test('takes the date from the heading, which is the only place it appears', () => {
    // No bus ticket in the corpus labels the day of travel.
    assert.equal(draft.value('date'), '2019-10-03');
  });
});

/*
 * AbhiBus. The heading is "Bangalore to Pune" at 68, beneath a masthead set at 108 —
 * so a threshold of four-fifths of the tallest line refused the very line wanted.
 *
 * Its traveller table is headed "Travellers | Age | Seat | Details", and the cell beside
 * the one that matched went onto the pass as the seat.
 */
test('AbhiBus: a heading smaller than the masthead above it', async (t) => {
  const draft = await build([
    [40, 108, [[16, 'AbhiBus Ticket'], [500, 'abhibus']]],
    [180, 68, [[16, 'Bangalore to Pune'], [300, '@02-01-2014']]],
    [260, 39, [[16, 'SRS Travels'], [350, 'Service # BNG-Mumbai Multi Axle']]],
    [320, 34, [[40, 'Boarding Point']]],
    [360, 37, [[40, 'B T M Layout (Pickup'], [420, 'Dropping Point']]],
    [400, 50, [[40, 'Van/Bus)Near Gangotri hospital ,'], [420, 'Pune']]],
    [470, 56, [[120, 'Travellers'], [250, 'Age'], [310, 'Seat'], [430, 'Details']]],
    [520, 30, [[120, 'Ganesh Bhatt'], [250, '25'], [310, '2'], [430, 'PNR # 5137704']]],
    [570, 28, [[40, 'Customer Support and Enquiries']]],
    [600, 26, [[40, 'SRS Travels'], [300, 'AbhiBus Customer Care (24*7)']]],
    [630, 26, [[300, '040-33667799']]],
    [670, 26, [[40, 'Terms and Conditions'], [420, 'Cancellation / Refunds:']]],
  ]);

  await t.test('takes the journey, not the pickup landmark', () => {
    assert.equal(draft.value('origin'), 'Bangalore');
    assert.equal(draft.value('destination'), 'Pune');
  });

  await t.test('does not put a column header on the pass as a seat', () => {
    const seat = draft.value('seat') || '';
    assert.ok(!/details/i.test(seat), `seat is "${seat}"`);
  });

  await t.test('reads a service numbered with a hash', () => {
    // "Service # BNG-Mumbai" carries no "no" or "number" for a pattern to match.
    assert.match(draft.value('service') || '', /BNG-Mumbai/);
  });

  await t.test('leaves an ambiguous all-numeric date blank rather than guessing', () => {
    // "02-01-2014" is either 2 January or 1 February. Refusing is deliberate: a pass a
    // month wrong is worse than one the user is asked to complete.
    assert.equal(draft.value('date'), '');
  });
});

/*
 * Paytm. The arrow between the two places is a graphic, so OCR returns no connecting
 * character at all — the route is simply two adjacent columns, and both the arrow and
 * the "to" tests miss. These tickets had no route whatsoever.
 */
test('Paytm: a route with no connecting character', async (t) => {
  const draft = await build([
    [40, 104, [[16, 'PaYTM Bus Ticket']]],
    [200, 75, [[60, 'Bengaluru'], [300, 'Proddatur'], [520, '20-07-2017']]],
    [320, 57, [[60, '9:30 PM'], [200, '9:45 PM'], [360, 'BOOKED'], [480, 'ORZ3RT']]],
    [420, 34, [[60, 'Lakshmi Devi'], [300, '4'], [420, 'ABRS5999772']]],
    [480, 30, [[60, 'Boarding Point']]],
    [520, 30, [[60, 'Sri Krishna Bavan Hotel, Silk Board']]],
    [560, 30, [[60, 'Dropping Point'], [300, 'Proddatur']]],
  ]);

  await t.test('reads two adjacent places as the journey', () => {
    assert.equal(draft.value('origin'), 'Bengaluru');
    assert.equal(draft.value('destination'), 'Proddatur');
  });

  await t.test('takes the date printed beside them', () => {
    assert.equal(draft.value('date'), '2017-07-20');
  });
});

/** A pair of captions side by side is not a journey, however large it is set. */
test('Paytm: two captions are not a route', async (t) => {
  const draft = await build([
    [40, 48, [[16, 'Paytm'], [400, '0120 4880880']]],
    [120, 49, [[60, 'Ticket ID'], [300, 'Order ID']]],
    [180, 32, [[60, '22ZELGZ3'], [300, '16627359514']]],
    [260, 48, [[60, 'DUNGARPUR'], [300, 'UDAIPUR']]],
    [300, 20, [[60, 'Tue, 28 Dec 2021'], [300, 'Tue, 28 Dec 2021']]],
    [320, 28, [[60, '7:20 PM'], [300, '9:50 PM']]],
    [360, 26, [[60, 'Bus Operator Name']]],
    [400, 24, [[60, 'Rishabh Travels']]],
    [440, 27, [[60, 'Boarding Point']]],
    [480, 26, [[60, 'Anita Maya Travels']]],
    [520, 26, [[60, 'Dropping Point'], [300, 'R K Circle']]],
  ]);

  await t.test('takes the places, not the identifiers above them', () => {
    assert.equal(draft.value('origin'), 'DUNGARPUR');
    assert.equal(draft.value('destination'), 'UDAIPUR');
  });

  await t.test('takes the date from the line beneath the route', () => {
    assert.equal(draft.value('date'), '2021-12-28');
  });
});

/*
 * goibibo. The arrow has no space before it — "Jaipur-> Bhim" — and a pictogram beside
 * the route is read as "fa)", which was taken as part of the origin.
 */
test('goibibo: an arrow with no space, and debris beside it', async (t) => {
  const draft = await build([
    [40, 120, [[16, 'goibibo | eticxer'], [400, 'Kalpana Travels Pvt. Ltd.']]],
    [120, 36, [[16, 'com'], [300, '9414033007 / 9414033029']]],
    [200, 56, [[16, 'fa) Jaipur-> Bhim Wednesday, August 10th, 2022'], [700, 'Confirmed']]],
    [260, 30, [[16, 'Mr Madhav Singh Charan']]],
    [300, 52, [[16, 'Non Seater/Sleeper A/C'], [300, 'Seat Number'], [500, 'Departure time']]],
    [340, 38, [[16, 'Boarding Point']]],
    [400, 28, [[16, '200ft Bypass,Jaipur-Ajmer']]],
    [440, 27, [[16, 'Highway,Jaipur']]],
    [480, 32, [[16, 'Dropping Point'], [300, 'Bhim']]],
  ]);

  await t.test('reads the journey', () => {
    assert.equal(draft.value('origin'), 'Jaipur');
    assert.equal(draft.value('destination'), 'Bhim');
  });

  await t.test('drops OCR debris from the icon beside it', () => {
    assert.ok(!/fa\)/.test(draft.value('origin')), `origin is "${draft.value('origin')}"`);
  });

  await t.test('takes the year that was printed, not the year it is now', () => {
    // A labelled date with no year falls back to the current year, so a journey in 2022
    // was dated 2026. The heading states the year in full, and a year read beats a year
    // assumed.
    assert.equal(draft.value('date'), '2022-08-10');
  });
});

/*
 * IRCTC. "Booked From" sits above "PRAYAGRAJ JN. - PRYJ" on a line of its own, and
 * skipping single-column lines beneath a multi-column header walked on to the row below,
 * whose leftmost cell is "ADP" — OCR debris from the arrow graphic between the columns.
 *
 * "Acronyms: RLWL, REMOTE LOCATION WAITLIST" is printed directly beneath the passenger
 * rows at the same spacing and in as many columns, so every geometric test passed it.
 */
test('IRCTC: a value on its own line, and a table that ends', async (t) => {
  const draft = await build([
    [20, 40, [[16, 'WL'], [200, 'Electronic Reservation Slip (ERS)-Normal User'], [700, 'WL']]],
    [120, 97, [[60, 'Booked From'], [300, 'fF'], [420, 'Boarding At'], [700, 'To']]],
    [200, 29, [[60, 'PRAYAGRAJ JN. - PRYJ']]],
    [240, 44, [[16, 'ADP'], [300, 'PRAYAGRAJ JN. 7 (PRYJ)'], [620, 'NEW DELHI - NDLS']]],
    [300, 38, [[60, 'Start Date* 17-Jan-2025'], [400, 'Departure* N.A.'], [700, 'Arrival* N.A.']]],
    [380, 44, [[60, 'PNR'], [350, 'Train No./Name'], [700, 'Class']]],
    [420, 63, [[60, '2555647395'], [350, '12275 / NDLS HUMSAFAR'], [700, 'SLEEPER CLASS (SL)']]],
    [500, 52, [[16, 'Passenger Details']]],
    [550, 39, [[16, '#'], [60, 'Name'], [280, 'Age'], [380, 'Gender'], [480, 'Booking Status'], [660, 'Current Status']]],
    [600, 44, [[16, '1.'], [60, 'ASHISH KUMAR YA'], [280, '30'], [380, 'M'], [480, 'WL/51'], [660, 'WL/37']]],
    [650, 29, [[16, 'Acronyms:'], [140, 'RLWL, REMOTE LOCATION WAITLIST'], [450, 'PQWL, POOLED QUOTA WAITLIST'], [700, 'RSWL: ROAD-SIDE WAITLIST']]],
  ]);

  await t.test('takes the station on its own line, not the debris below it', () => {
    assert.ok(!/^adp$/i.test(draft.value('origin')), `origin is "${draft.value('origin')}"`);
    assert.match(draft.value('origin'), /PRYJ|PRAYAGRAJ/i);
  });

  await t.test('stops the passenger table where the acronym key begins', () => {
    const people = draft.passengers || [draft.value('passenger')].filter(Boolean);
    for (const name of people) {
      assert.ok(!/acronym/i.test(name), `"${name}" is the acronym key, not a passenger`);
    }
    assert.equal(people.length, 1, `expected 1 passenger, got ${people.join(', ')}`);
  });
});
