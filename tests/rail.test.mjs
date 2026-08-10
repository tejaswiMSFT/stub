/**
 * Tests for the ground-transport adapter and the seat parser it shares with events.
 *
 * The seat cases matter disproportionately: a dropped seat is discovered at the door,
 * and a mis-read date puts someone on a platform on the wrong day. Both are tested
 * against the awkward real-world forms rather than tidy ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSeats, summariseSeats } from '../js/adapters/event.js';
import railAdapter, { classify, Mode, parseStation, parseCoachBerth } from '../js/adapters/rail.js';

/** Builds the line objects the text layer would produce, for a labelled two-column row. */
function linesFrom(rows) {
  return rows.map((text, index) => ({
    text,
    x: 0,
    y: index * 12,
    width: text.length * 6,
    height: 10,
    items: [],
  }));
}

function contextFrom(rows, barcode = null) {
  return { lines: linesFrom(rows), barcode };
}

// ────────────────────────────── seat parsing ──────────────────────────────

test('seat parsing', async (t) => {
  await t.test('keeps every seat when runs from two rows are combined', () => {
    const parsed = parseSeats('G1-G9, C1-C3');
    assert.equal(parsed.count, 12, 'all twelve seats must survive');
    assert.ok(parsed.seats.includes('G1'));
    assert.ok(parsed.seats.includes('G9'));
    assert.ok(parsed.seats.includes('C1'), 'the second run must not be dropped');
    assert.ok(parsed.seats.includes('C3'));
  });

  await t.test('expands a single run', () => {
    const parsed = parseSeats('A5-A7');
    assert.deepEqual(parsed.seats, ['A5', 'A6', 'A7']);
    assert.equal(parsed.expandedRange, true);
  });

  await t.test('lets a bare number inherit the previous row', () => {
    const parsed = parseSeats('A5, 6, 7');
    assert.deepEqual(parsed.seats, ['A5', 'A6', 'A7']);
  });

  await t.test('handles slash separation', () => {
    const parsed = parseSeats('A5/A6');
    assert.deepEqual(parsed.seats, ['A5', 'A6']);
  });

  await t.test('does not invent seats across rows', () => {
    const parsed = parseSeats('G10-C2');
    assert.ok(!parsed.seats.includes('G11'), 'a cross-row range has no defined ordering');
  });

  await t.test('de-duplicates', () => {
    const parsed = parseSeats('A5, A5, A6');
    assert.equal(parsed.count, 2);
  });

  await t.test('returns nothing for unparseable input', () => {
    assert.equal(parseSeats('best available'), null);
    assert.equal(parseSeats(''), null);
  });
});

test('seat summarising', async (t) => {
  await t.test('collapses a run of three or more into a range', () => {
    assert.equal(summariseSeats(['G5', 'G6', 'G7']).summary, 'G5–G7');
  });

  await t.test('leaves a pair listed, being shorter than a range', () => {
    assert.equal(summariseSeats(['G5', 'G6']).summary, 'G5, G6');
  });

  await t.test('falls back to a count rather than truncating', () => {
    const seats = Array.from({ length: 14 }, (_, i) => `${'ABCDEFG'[i % 7]}${i + 1}`);
    const result = summariseSeats(seats);
    assert.match(result.summary, /^\d+ seats$/);
    assert.equal(result.overflowed, true);
    assert.ok(result.condensed, 'the full list must still be carried for the back of the pass');
  });

  await t.test('never loses a seat between the summary and the full list', () => {
    const seats = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'C1', 'C2', 'C3'];
    const result = summariseSeats(seats);
    const source = result.overflowed ? result.condensed : result.summary;
    for (const row of ['G', 'C']) {
      assert.ok(source.includes(row), `row ${row} must appear in the rendered allocation`);
    }
  });
});

// ────────────────────────────── mode classification ──────────────────────────────

test('rail and bus classification', async (t) => {
  await t.test('recognises an IRCTC train ticket', () => {
    const result = classify(contextFrom([
      'IRCTC Electronic Reservation Slip',
      'Train No. 12658  KSR BENGALURU CITY',
      'Coach S7   Berth 42  LB',
      'Class SL   Quota GN   Status CNF',
    ]));
    assert.equal(result.mode, Mode.RAIL);
    assert.ok(result.score >= 40);
  });

  await t.test('recognises a KSRTC bus ticket', () => {
    const result = classify(contextFrom([
      'Karnataka State Road Transport Corporation',
      'KSRTC  Airavat Club Class',
      'Boarding Point: Mysore Road Satellite Bus Stand',
      'Dropping Point: Kozhikode',
      'Seat No: 21, 22',
    ]));
    assert.equal(result.mode, Mode.BUS);
    assert.ok(result.score >= 40);
  });

  await t.test('recognises a BMTC service', () => {
    const result = classify(contextFrom([
      'BMTC Vayu Vajra',
      'Service No KIAS-8',
      'Boarding Point: Kempegowda Bus Station',
    ]));
    assert.equal(result.mode, Mode.BUS);
  });

  await t.test('declines a document that is neither', () => {
    const result = classify(contextFrom([
      'Invoice',
      'Amount due 4,200.00',
      'Thank you for your custom',
    ]));
    assert.equal(result.score, 0);
  });

  await t.test('does not claim a retiring room booking as a journey', () => {
    const score = railAdapter.detect(contextFrom([
      'IRCTC Retiring Room Booking',
      'Check-in 14:00   Check-out 12:00',
      'Dormitory bed 3',
    ]));
    assert.equal(score, 0, 'a stay has no origin or destination to show');
  });

  await t.test('prefers rail when coach and berth are present despite the word sleeper', () => {
    const result = classify(contextFrom([
      'Sleeper Class',
      'Coach S4  Berth 18',
      'Train No 16022',
    ]));
    assert.equal(result.mode, Mode.RAIL);
  });
});

// ────────────────────────────── station parsing ──────────────────────────────

test('station parsing', async (t) => {
  await t.test('separates a bracketed code', () => {
    const station = parseStation('KSR BENGALURU CY JN (SBC)');
    assert.equal(station.code, 'SBC');
    assert.match(station.name, /Bengaluru/);
  });

  await t.test('separates a leading code', () => {
    const station = parseStation('MAS - Chennai Central');
    assert.equal(station.code, 'MAS');
    assert.equal(station.name, 'Chennai Central');
  });

  await t.test('keeps a plain name', () => {
    const station = parseStation('Kozhikode');
    assert.equal(station.name, 'Kozhikode');
    assert.equal(station.code, null);
  });

  await t.test('preserves station abbreviations rather than title-casing them', () => {
    const station = parseStation('BENGALURU CY JN (SBC)');
    assert.ok(station.name.includes('JN'), 'JN must not become "Jn"');
  });
});

// ────────────────────────────── coach and berth ──────────────────────────────

test('coach and berth parsing', async (t) => {
  await t.test('reads comma-separated notation', () => {
    const parsed = parseCoachBerth('S7, 42, LB');
    assert.equal(parsed.coach, 'S7');
    assert.equal(parsed.number, '42');
    assert.equal(parsed.position, 'LB');
    assert.equal(parsed.positionName, 'Lower');
  });

  await t.test('reads slash-separated notation', () => {
    const parsed = parseCoachBerth('B2/34/UB');
    assert.equal(parsed.coach, 'B2');
    assert.equal(parsed.number, '34');
    assert.equal(parsed.position, 'UB');
  });

  await t.test('expands a spelled-out berth position', () => {
    const parsed = parseCoachBerth('A1 12 SIDE LOWER');
    assert.equal(parsed.position, 'SL');
    assert.equal(parsed.positionName, 'Side lower');
  });

  await t.test('returns nothing when there is nothing to read', () => {
    assert.equal(parseCoachBerth(''), null);
  });
});

// ────────────────────────────── end-to-end drafts ──────────────────────────────

test('building a draft', async (t) => {
  await t.test('produces a train pass with the right transit type', async () => {
    const draft = await railAdapter.build(contextFrom([
      'IRCTC Electronic Reservation Slip',
      'Train No.  12658',
      'From  KSR BENGALURU CY JN (SBC)',
      'To  MAS - Chennai Central',
      'Date of Journey  16 Sep 2026',
      'Departure  22:40',
      'Coach  S7',
      'Berth  42',
      'PNR  4571234567',
    ]));

    assert.equal(draft.style, 'boardingPass');
    assert.equal(draft.transitType, 'PKTransitTypeTrain');
    assert.equal(draft.type, 'rail');
    assert.equal(draft.value('origin'), 'SBC');
    assert.equal(draft.value('destination'), 'MAS');
    assert.equal(draft.value('date'), '2026-09-16');
    assert.equal(draft.value('departureTime'), '22:40');
  });

  await t.test('produces a bus pass with the bus transit type', async () => {
    const draft = await railAdapter.build(contextFrom([
      'KSRTC Airavat Club Class',
      'Service No  BNG-KZD-2145',
      'Boarding Point  Mysore Road Satellite Bus Stand',
      'Dropping Point  Kozhikode New Bus Stand',
      'Date  16 Sep 2026',
      'Seat No  21, 22',
    ]));

    assert.equal(draft.transitType, 'PKTransitTypeBus');
    assert.equal(draft.type, 'bus');
    assert.ok(draft.get('boardingPoint'), 'a bus pass must carry its boarding point');
    assert.equal(draft.get('seat').label, 'Seats');
  });

  await t.test('never throws on a ticket it barely understands', async () => {
    const draft = await railAdapter.build(contextFrom([
      'BUS TICKET',
      'Some operator nobody has heard of',
      '17-09-2026',
    ]));
    assert.ok(draft, 'a sparse pass is better than an error');
    assert.equal(draft.style, 'boardingPass');
    assert.ok(draft.fieldsNeedingReview.length > 0, 'the user must be asked to fill the gaps');
  });

  await t.test('refuses to guess an ambiguous numeric date', async () => {
    const draft = await railAdapter.build(contextFrom([
      'KSRTC Bus Ticket',
      'Boarding Point  Majestic',
      'Date of Journey  09/10/2026',
    ]));

    const date = draft.get('date');
    assert.equal(date.value, '', 'a date readable two ways must not be chosen for the user');
    assert.ok(date.issues.some((issue) => issue.code === 'ambiguous-date'));
    assert.equal(date.options.length, 2, 'both readings must be offered');
  });

  await t.test('warns when a rail booking is waitlisted', async () => {
    const draft = await railAdapter.build(contextFrom([
      'IRCTC Electronic Reservation Slip',
      'Train No.  12658',
      'Status  WL 12',
      'Coach  S7',
    ]));

    const status = draft.get('status');
    assert.ok(status, 'booking status must be surfaced');
    assert.ok(status.issues.some((issue) => issue.code === 'waitlisted'));
  });

  await t.test('says so when there is no barcode to carry', async () => {
    const draft = await railAdapter.build(contextFrom([
      'KSRTC Bus Ticket',
      'Boarding Point  Majestic',
    ]));
    assert.ok(
      draft.warnings.some((warning) => /no barcode/i.test(warning)),
      'the user must be told the pass carries no scannable code',
    );
  });
});
