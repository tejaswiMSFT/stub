/**
 * Traps: text that looks like a field but is not.
 *
 * Every case is a document containing a correct value and, nearby, something that could
 * plausibly be mistaken for it. The correct value must win.
 *
 * The list comes from published standards rather than from tickets we happen to hold —
 * IATA record-locator and flight-number rules, the BCBP field layout, fare basis codes,
 * bag tags — because the point is to test against things the extractor was *not* built
 * from. Three were real failures found in use; the rest are the same shape of mistake
 * waiting to happen.
 *
 * Deliberately not any one operator's ticket. A trap is a property of the vocabulary,
 * not of a vendor, and writing them as one company's layout would invite exactly the
 * anchoring this exists to catch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extract } from '../js/adapters/index.js';
import { buildLines } from '../js/text.js';

/**
 * Places text at real coordinates.
 *
 * Positions matter as much as words: an earlier version of this harness laid everything
 * out with runs of spaces, the column splitter saw one cell per line, and a passenger
 * table went unread — a flaw in the test that looked exactly like a flaw in the app.
 */
function page(rows) {
  const items = [];
  for (const [y, cells] of rows) {
    for (const [x, text] of cells) {
      items.push({ text, x, y, width: text.length * 6.2, height: 11 });
    }
  }
  return buildLines(items, { pageWidth: 780 });
}

const read = async (lines) => extract({ lines, barcode: null, ingested: {} });

test('a value is not confused with something that merely looks like one', async (t) => {
  await t.test('a mobile number is not a passenger', async () => {
    // Real failure: an ixigo-issued slip prints "Passenger Mobile No : 9794998703", which
    // matched the pattern for "Passenger" and put a phone number on the pass as a name.
    const draft = await read(page([
      [60, [[40, 'PNR No. : 2364927203'], [340, 'Train No. & Name : 15708/ASR KIR EXPRESS']]],
      [80, [[40, 'From: Ambala Cant Jn (UMB)'], [340, 'To : Deoria Sadar (DEOS)']]],
      [100, [[40, 'Passenger Mobile No : 9794998703'], [340, 'Distance: 1030.0 km(s)']]],
      [140, [[40, 'Passenger Details']]],
      [160, [[40, 'S No.'], [110, 'Name'], [340, 'Age'], [400, 'Sex'], [500, 'Booking Status']]],
      [180, [[40, '1'], [110, 'RAMPRATAP YADAV'], [340, '27'], [400, 'Male (M)'], [500, 'CNF/S9/65/LB']]],
    ]));

    assert.equal(draft.value('passenger'), 'RAMPRATAP YADAV');
  });

  await t.test('a document title is not an airline', async () => {
    // Real failure: "E-ticket" set large across the top is the most prominent text on the
    // page, and was reported as the operator.
    const draft = await read(page([
      [40, [[40, 'E-ticket']]],
      [60, [[40, 'Departure Flight']]],
      [120, [[40, 'AirAsia'], [300, 'Thursday, 18 May 2023']]],
      [140, [[40, 'AK-5233'], [300, '11:25'], [420, 'Kuching (KCH)']]],
      [160, [[40, 'Subclass Z ( Economy )'], [300, '13:10'], [420, 'Kuala Lumpur (KUL)']]],
    ]));

    assert.ok(!/e-?ticket/i.test(draft.value('provider')), `read the title as the airline: ${draft.value('provider')}`);
  });

  await t.test('a word in prose is not a flight number', async () => {
    // Real failure: "ID 7" was carved out of "identification" followed by a stray digit,
    // and taken as the flight because it matched a carrier-code-plus-digits pattern.
    const draft = await read(page([
      [40, [[40, 'E-ticket']]],
      [60, [[40, 'Departure Flight']]],
      [120, [[40, 'AirAsia'], [300, 'Thursday, 18 May 2023']]],
      [140, [[40, 'AK-5233'], [300, '11:25'], [420, 'Kuching (KCH)']]],
      [160, [[40, 'Subclass Z ( Economy )'], [300, '13:10'], [420, 'Kuala Lumpur (KUL)']]],
      [220, [[40, 'Present e-ticket and valid identification at check-in']]],
    ]));

    assert.match(draft.value('flight') || draft.value('service') || '', /AK\s*5233/i);
  });

  await t.test('a carrier code beginning with a digit is still a carrier code', async () => {
    // IndiGo is 6E, Jet Airways was 9W. IATA designators may be letter-letter,
    // letter-digit or digit-letter, so a pattern demanding two letters loses a whole
    // class of airline.
    // Source: en.wikipedia.org/wiki/IATA_airline_designator
    const draft = await read(page([
      [40, [[40, 'BOARDING PASS']]],
      [70, [[40, 'Flight'], [200, '6E 5306']]],
      [90, [[40, 'From'], [200, 'BLR'], [400, 'To'], [500, 'IXE']]],
      [110, [[40, 'PNR'], [200, 'NC1FKG']]],
    ]));

    assert.match(draft.value('flight') || draft.value('service') || '', /6E\s*5306/i);
  });

  await t.test('a tax identifier is not a booking reference', async () => {
    // Any ticket that doubles as an invoice prints these in the same grid as the booking
    // reference, holding values of exactly the same shape — a GSTIN is 15 alphanumeric
    // characters, a VAT number and a TIN are in the same range.
    //
    // Every variant, not just the one that was reported: the document that prints GSTIN
    // prints CGST and SGST beside it, and a guard against only the first guards nothing.
    //
    // Laid out as label-above-value, which is the layout this reads correctly today. The
    // side-by-side form is covered by the standalone case below, which asserts only that
    // the tax number is refused — the reference itself is not always found there, for the
    // separate reason recorded at the end of this file.
    const draft = await read(page([
      [40, [[40, 'TAX INVOICE']]],
      [70, [[40, 'GSTIN'], [220, '07AABCU9603R1ZM']]],
      [90, [[40, 'PAN No'], [220, 'AABCU9603R']]],
      [110, [[40, 'CGST'], [220, '9%'], [400, 'SGST'], [520, '9%']]],
      [130, [[40, 'VAT Reg No'], [220, 'GB123456789']]],
      [150, [[40, 'TIN'], [220, '29070102345']]],
      [190, [[40, 'Booking Reference']]],
      [210, [[40, 'Q7XK2M']]],
      [240, [[40, 'Flight']]],
      [260, [[40, '6E 2134']]],
      [290, [[40, 'From'], [220, 'To']]],
      [310, [[40, 'BLR'], [220, 'DEL']]],
    ]));

    assert.equal(draft.value('pnr'), 'Q7XK2M');
    assert.equal(draft.value('origin'), 'BLR');
    assert.equal(draft.value('destination'), 'DEL');
  });

  await t.test('a tax identifier is not a booking reference, even standing alone', async () => {
    // The harder case: no other reference on the page at all. Reading the GSTIN here
    // would look like a success and be quoted at a desk.
    //
    // Note this document is currently *refused* — a tax invoice with one flight line
    // does not score highly enough to be recognised — which is the correct answer for a
    // receipt and would be the wrong one for a ticket that happens to carry tax details.
    // Asserted as "does not report a tax number as a reference", which holds either way,
    // rather than asserting a refusal that ought to change.
    let value = '';
    try {
      const draft = await read(page([
        [40, [[40, 'TAX INVOICE']]],
        [70, [[40, 'GST No'], [220, '07AABCU9603R1ZM']]],
        [100, [[40, 'Flight'], [220, '6E 2134']]],
        [120, [[40, 'From'], [220, 'BLR'], [420, 'To'], [520, 'DEL']]],
        [140, [[40, 'Passenger Name'], [220, 'TEJASWI C']]],
      ]));
      value = draft.value('pnr') || '';
    } catch {
      // Refused outright, which cannot report a tax number as anything.
    }

    assert.ok(!/AABCU/i.test(value), `read a tax number as a booking reference: ${value}`);
  });

  await t.test('seat and class are read in every mode', async () => {
    /*
     * Class appears on air, rail and bus tickets; seat on all three and on cinema
     * tickets too; berth only on rail. All are captions wherever they appear, and none
     * was listed as one — so the search fell through to the row below and took the next
     * caption as the value. A seat on a flight read "PNR", a seat on a bus read "Service
     * No", and a class on a rail ticket read "BERTH".
     *
     * Three modes in one test because the fault was shared: it lived in the label
     * vocabulary, not in any one adapter, and testing a single mode would have left the
     * other two to fail quietly.
     */
    const flight = await read(page([
      [40, [[40, 'BOARDING PASS']]],
      [70, [[40, 'Flight'], [220, '6E 5306']]],
      [90, [[40, 'From'], [220, 'BLR'], [420, 'To'], [520, 'IXE']]],
      [110, [[40, 'Seat'], [220, '10F'], [420, 'Class'], [520, 'Economy']]],
      [130, [[40, 'PNR'], [220, 'NC1FKG']]],
    ]));

    assert.equal(flight.value('seat'), '10F');
    assert.equal(flight.value('cabin'), 'Economy');

    const rail = await read(page([
      [40, [[40, 'Electronic Reservation Slip']]],
      [70, [[40, 'PNR'], [220, '1234567890']]],
      [90, [[40, 'Train No.'], [220, '16540']]],
      [110, [[40, 'From'], [220, 'MAJN'], [420, 'To'], [520, 'YPR']]],
      [130, [[40, 'Class'], [220, '3E'], [420, 'Coach'], [520, 'M1']]],
      [150, [[40, 'Berth'], [220, '17']]],
    ]));

    assert.equal(rail.value('seat'), '17');
    assert.equal(rail.value('class'), '3E');

    const bus = await read(page([
      [40, [[40, 'KSRTC Airavat Club Class']]],
      [70, [[40, 'Boarding Point'], [220, 'Mangaluru']]],
      [90, [[40, 'Dropping Point'], [220, 'Bengaluru']]],
      [110, [[40, 'Seat No'], [220, 'A1']]],
      [130, [[40, 'Service No'], [220, '1234']]],
    ]));

    assert.equal(bus.value('seat'), 'A1');
  });

  await t.test('stacked captions with values to the right', async () => {
    /*
     * The layout that broke every field at once.
     *
     * An Emirates receipt sets its captions in one column — PASSENGER NAME, BOOKING
     * REFERENCE, E-TICKET NUMBER, ISSUED BY / DATE — with the values out to the right.
     * What sits directly *below* each caption is therefore the next caption, and the
     * search looked below first: the passenger read "ISSUED BY / DATE", the booking
     * reference read "E-TICKET NUMBER", the seat read "ALLOWANCE 30 KGS".
     *
     * The same page then uses the opposite layout for its flight table — captions across
     * a header row with values beneath — so an app that simply reversed the order would
     * trade one broken ticket for another. Both are asserted here for that reason.
     */
    const draft = await read([
      ...page([
        [60, [[755, 'e-Ticket Receipt & Itinerary']]],
        [80, [[755, 'Emirates']]],
        [283, [[755, 'PASSENGER NAME'], [900, 'LARRY JOHNSON']]],
        [300, [[755, 'BOOKING REFERENCE'], [900, 'DDY37W']]],
        [317, [[755, 'E-TICKET NUMBER'], [900, '138 3012574759']]],
        [334, [[755, 'ISSUED BY / DATE'], [900, 'DUBAI EMIRATES IBE']]],
        [370, [[755, 'TRAVEL INFORMATION']]],
        [390, [[755, 'FLIGHT'], [860, 'DEPARTURE/ARRIVE'], [990, 'AIRPORT/TERMINAL'], [1130, 'CLASS']]],
        [408, [[755, 'EK 241'], [860, '26 OCT 21'], [990, 'HAMAD INTL (DOH)'], [1130, 'ECONOMY']]],
        [422, [[755, 'CONFIRMED'], [860, '1427'], [990, 'TERMINAL 2']]],
      ]),
    ]);

    // Read from the stacked half, where the value is beside its caption.
    assert.equal(draft.value('passenger'), 'LARRY JOHNSON');
    assert.equal(draft.value('pnr'), 'DDY37W');

    // Read from the table half, where the value is beneath its caption.
    assert.match(draft.value('flight') || '', /EK\s*241/i);
    assert.equal(draft.value('cabin'), 'ECONOMY');
  });

  await t.test('a station name is not a cancellation', async () => {
    /*
     * The most alarming thing this app has got wrong.
     *
     * A confirmed IRCTC ticket showed a status of CAN, which anyone would read as
     * cancelled. "CAN" was in the list of status codes, and it is three letters that
     * occur inside ordinary words — including on that very ticket, whose boarding
     * station is "Ambala Cant Jn". Cancellation is now recognised only from the whole
     * word, which no station name contains.
     */
    const draft = await read(page([
      [40, [[40, 'Electronic Reservation Slip']]],
      [60, [[40, 'PNR No. : 2364927203'], [340, 'Train No. & Name : 15708/ASR KIR EXPRESS']]],
      [80, [[40, 'From: Ambala Cant Jn (UMB)'], [340, 'To : Deoria Sadar (DEOS)']]],
      [100, [[40, 'Boarding: Ambala Cant Jn (UMB)'], [340, 'Date of Journey: 2019-10-11']]],
      [140, [[40, 'Passenger Details']]],
      [160, [[40, 'S No.'], [110, 'Name'], [340, 'Age'], [400, 'Sex'], [500, 'Booking Status'], [640, 'Current Status']]],
      [180, [[40, '1'], [110, 'RAMPRATAP YADAV'], [340, '27'], [400, 'Male (M)'], [500, 'CNF/S9/65/LB'], [640, 'CNF/S9/65/LB']]],
    ]));

    assert.equal(draft.value('status'), 'CNF');
    assert.equal(draft.value('passenger'), 'RAMPRATAP YADAV');
  });

  await t.test('a codeshare number is not the flight boarded', async () => {
    // A segment commonly shows both the operating and the marketing flight number. The
    // passenger boards the operating one.
    const draft = await read(page([
      [40, [[40, 'BOARDING PASS']]],
      [70, [[40, 'Flight'], [200, 'LH 760']]],
      [90, [[40, 'Marketed as'], [200, 'UA 8839']]],
      [110, [[40, 'From'], [200, 'DEL'], [400, 'To'], [500, 'FRA']]],
    ]));

    assert.match(draft.value('flight') || draft.value('service') || '', /LH\s*760/i);
  });

  await t.test('an airport name containing a city is still read as its code', async () => {
    // "Indira Gandhi International Airport, New Delhi (DEL)" — the bracketed code is the
    // only unambiguous part, and the words around it are not a destination.
    const draft = await read(page([
      [40, [[40, 'ITINERARY']]],
      [70, [[40, 'Origin'], [240, 'Indira Gandhi International Airport, New Delhi (DEL)']]],
      [90, [[40, 'Destination'], [240, 'Chennai International Airport, Chennai (MAA)']]],
      [110, [[40, 'Flight'], [240, '6E 5375']]],
    ]));

    assert.equal(draft.value('origin'), 'DEL');
    assert.equal(draft.value('destination'), 'MAA');
  });

  await t.test('an itinerary with no hyphenated sector is still a ticket', async () => {
    // Real failure: an AirAsia e-ticket scored 35 against a threshold of 40 and was
    // refused outright. It writes its route as "Kuching (KCH)" rather than "KCH-KUL",
    // never uses the word "airport", and prints its flight number under the logo with no
    // caption — so none of the signals the detector looked for was present.
    const draft = await read(page([
      [40, [[40, 'E-ticket']]],
      [60, [[40, 'Departure Flight']]],
      [120, [[40, 'AirAsia'], [300, 'Thursday, 18 May 2023']]],
      [140, [[40, 'AK-5233'], [300, '11:25'], [420, 'Kuching (KCH)']]],
      [160, [[40, 'Subclass Z ( Economy )'], [300, '13:10'], [420, 'Kuala Lumpur (KUL)']]],
    ]));

    assert.equal(draft.type, 'flight');

    // The route is not asserted, and that is a statement rather than an omission: this
    // layout labels neither end. The codes sit in a column beside the times with no
    // caption anywhere, which is the same shape as an Emirates receipt printing "HAMAD
    // INTL (DOH)" under an AIRPORT/TERMINAL heading. Reading either needs the table's
    // geometry rather than a label, and that is not built yet.
    //
    // Being accepted at all is the fix under test here. A pass the user completes by
    // hand is worth having; a refusal is not.
  });
});
