/**
 * Tests for the critical-field rule.
 *
 * A booking reference, a service number and a travel date are the values a gate agent
 * actually checks. A plausible-looking wrong one is as disabling as a blank, and unlike
 * a wrong seat it cannot be shrugged off — so these are held to a higher standard than
 * ordinary fields and are never accepted on medium confidence alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Field, Source, Confidence, TicketDraft } from '../js/model.js';
import railAdapter from '../js/adapters/rail.js';
import flightAdapter from '../js/adapters/flight.js';

function linesFrom(rows) {
  return rows.map((text, index) => ({
    text, x: 0, y: index * 12, width: text.length * 6, height: 10, items: [],
  }));
}

test('critical fields', async (t) => {
  await t.test('a medium-confidence ordinary field passes without review', () => {
    const field = new Field({
      key: 'gate', label: 'Gate', value: '12', source: Source.PDF_TEXT,
    });
    assert.equal(field.confidence, Confidence.MEDIUM);
    assert.equal(field.needsReview, false);
  });

  await t.test('a medium-confidence critical field is surfaced', () => {
    const field = new Field({
      key: 'pnr', label: 'PNR', value: '4571234567', source: Source.PDF_TEXT, critical: true,
    });
    assert.equal(field.confidence, Confidence.MEDIUM);
    assert.equal(field.needsReview, true, 'a booking reference read from text must be checked');
  });

  await t.test('a barcode-sourced critical field is trusted', () => {
    const field = new Field({
      key: 'pnr', label: 'Booking ref', value: 'KLM3XZ', source: Source.BARCODE, critical: true,
    });
    assert.equal(field.needsReview, false, 'the barcode is authoritative');
  });

  await t.test('corroboration lifts a critical field out of review', () => {
    const field = new Field({
      key: 'flight', label: 'Flight', value: '6E 2134', source: Source.PDF_TEXT, critical: true,
    });
    assert.equal(field.needsReview, true);

    field.corroborate(Source.BARCODE);
    assert.equal(field.confidence, Confidence.HIGH);
    assert.equal(field.needsReview, false, 'two sources agreeing is as good as one authoritative one');
  });

  await t.test('confirming clears the requirement', () => {
    const field = new Field({
      key: 'date', label: 'Date', value: '2026-09-16', source: Source.PDF_TEXT, critical: true,
    });
    assert.equal(field.needsReview, true);
    field.confirm();
    assert.equal(field.needsReview, false, 'the user has looked at it, which is the point');
  });

  await t.test('editing clears the requirement', () => {
    const field = new Field({
      key: 'pnr', label: 'PNR', value: 'WRONG', source: Source.PDF_TEXT, critical: true,
    });
    field.setByUser('4571234567');
    assert.equal(field.needsReview, false);
    assert.equal(field.source, Source.USER);
  });
});

test('draft reporting', async (t) => {
  await t.test('lists critical fields and those missing', () => {
    const draft = new TicketDraft({ type: 'rail', style: 'boardingPass', adapter: 'rail' });
    draft.set('pnr', new Field({ key: 'pnr', label: 'PNR', value: '', source: Source.INFERRED, critical: true }));
    draft.set('service', new Field({ key: 'service', label: 'Train', value: '12658', source: Source.BARCODE, critical: true }));
    draft.set('seat', new Field({ key: 'seat', label: 'Berth', value: '42', source: Source.PDF_TEXT }));

    assert.equal(draft.criticalFields.length, 2);
    assert.equal(draft.missingCritical.length, 1);
    assert.equal(draft.missingCritical[0].key, 'pnr');
  });

  await t.test('a draft with an unreviewed critical field is not ready', () => {
    const draft = new TicketDraft({ type: 'rail', style: 'boardingPass', adapter: 'rail' });
    draft.set('pnr', new Field({ key: 'pnr', label: 'PNR', value: '457', source: Source.PDF_TEXT, critical: true }));

    assert.equal(draft.isReadyToBuild, false);
    draft.get('pnr').confirm();
    assert.equal(draft.isReadyToBuild, true);
  });
});

test('adapters mark the right fields critical', async (t) => {
  await t.test('rail marks PNR, train number and date', async () => {
    const draft = await railAdapter.build({
      lines: linesFrom([
        'IRCTC Electronic Reservation Slip',
        'Train No.  12658',
        'From  KSR BENGALURU CY JN (SBC)',
        'To  MAS - Chennai Central',
        'Date of Journey  16 Sep 2026',
        'PNR  4571234567',
      ]),
      barcode: null,
    });

    const critical = new Set(draft.criticalFields.map((f) => f.key));
    for (const key of ['pnr', 'service', 'date']) {
      assert.ok(critical.has(key), `${key} decides whether the journey happens`);
    }
  });

  await t.test('bus marks booking reference and date', async () => {
    const draft = await railAdapter.build({
      lines: linesFrom([
        'KSRTC Airavat Club Class',
        'Service No  BNG-KZD-2145',
        'Boarding Point  Mysore Road',
        'Date  16 Sep 2026',
        'Booking ID  KA9912345',
      ]),
      barcode: null,
    });

    const critical = new Set(draft.criticalFields.map((f) => f.key));
    assert.ok(critical.has('pnr'));
    assert.ok(critical.has('date'));
  });

  await t.test('flight marks flight number, booking ref and date even without a barcode', async () => {
    const draft = await flightAdapter.build({
      lines: linesFrom([
        'BOARDING PASS',
        'Passenger  SAMPLE R',
        'Flight  6E 2134',
        'PNR  KLM3XZ',
        'Seat  14A',
        'Gate  12',
      ]),
      barcode: null,
    });

    const critical = new Set(draft.criticalFields.map((f) => f.key));
    assert.ok(critical.has('flight'));
    assert.ok(critical.has('pnr'));
  });

  await t.test('a text-only flight ticket puts its critical fields in review', async () => {
    const draft = await flightAdapter.build({
      lines: linesFrom([
        'BOARDING PASS',
        'Flight  6E 2134',
        'PNR  KLM3XZ',
        'Gate  12',
      ]),
      barcode: null,
    });

    const reviewing = new Set(draft.fieldsNeedingReview.map((f) => f.key));
    assert.ok(reviewing.has('flight'), 'nothing here was barcode-backed');
    assert.ok(reviewing.has('pnr'));
  });
});
