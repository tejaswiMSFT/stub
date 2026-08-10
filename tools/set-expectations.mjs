/**
 * Fills in a fixture's `expect` block.
 *
 * Kept separate from make-fixture.mjs deliberately. Expectations must be stated by hand
 * after looking at the ticket, never generated from what the parser currently produces —
 * a fixture that asserts today's behaviour proves only that nothing has changed, which
 * is precisely the failure mode these tests exist to avoid.
 */

import { readFile, writeFile } from 'node:fs/promises';

const EXPECTATIONS = {
  'indigo-flight': {
    adapter: 'flight',
    type: 'flight',
    fields: {
      pnr: 'AB1CD2',
      origin: 'BLR',
      destination: 'IXE',
      flight: '6E 5306',
      date: '2026-09-16',
      seat: '10F',
      departureTime: '14:35',
      arrivalTime: '15:35',
      terminal: '1',
    },
    critical: ['pnr', 'flight', 'date'],
    // The booking time, 07:14, must never be reported as a departure — it would send
    // someone to the airport seven hours early, with an air of authority.
    absent: ['gate'],
  },

  'irctc-rail': {
    adapter: 'rail',
    type: 'rail',
    fields: {
      pnr: '1234567890',
      origin: 'MAJN',
      destination: 'YPR',
      service: '16540 / MAJN YPR EXP',
      date: '2026-09-13',
      departureTime: '07:00',
      arrivalTime: '16:30',
      coach: 'M1',
      seat: '17',
      berthPosition: 'Lower',
      passenger: 'SAMPLE',
      provider: 'IRCTC',
      class: '3E',
      status: 'CNF',
      quota: 'GENERAL (GN)',
    },
    critical: ['pnr', 'service', 'date', 'passenger', 'coach', 'seat'],
  },

  // Air India Express. A different flight layout entirely, and every difference is a
  // test: the terminal is buried at the end of an airport name rather than labelled,
  // times are bare with the date on a separate line, and the airline is named only in
  // the phrase "Operated by Air India Express".
  'airindia-express': {
    adapter: 'flight',
    type: 'flight',
    fields: {
      pnr: 'AB1CD2',
      origin: 'BLR',
      destination: 'IXE',
      flight: 'IX 1531',
      date: '2026-09-16',
      seat: '10F',
      departureTime: '14:40',
      arrivalTime: '16:00',
      terminal: '2',
      provider: 'Air India Express',
      passenger: 'SAMPLE',
    },
    critical: ['pnr', 'flight', 'date', 'origin', 'destination'],
    // "Booked on Wed, Jul 29 2026, 03:22 (UTC)" is a booking timestamp seven weeks
    // before travel, and there is no gate on an itinerary issued at booking.
    absent: ['gate'],
  },

  // An IRCTC confirmation email printed to PDF — the inline-email path, which no other
  // fixture covers. Three things make it valuable:
  //
  //  1. The addressee is NOT the passenger. It opens "Dear <booker>" while the passenger
  //     table names someone else entirely. Naming the wrong person on a pass shown at a
  //     barrier is a real failure, not a cosmetic one.
  //  2. It carries Gmail chrome — From, To, subject, timestamps — that must not be
  //     mistaken for ticket data. The email's own "at 2:34 PM" is not a departure.
  //  3. There is no barcode at all. This is the ERS/VRM path, and the app must say so
  //     plainly rather than invent one.
  'irctc-email': {
    adapter: 'rail',
    type: 'rail',
    fields: {
      pnr: '1234567890',
      origin: 'YPR',
      destination: 'MAJN',
      service: '16575 / GOMTESHWARA EXP',
      date: '2025-06-01',
      departureTime: '07:00',
      arrivalTime: '16:40',
      coach: 'C1',
      seat: '38',
      passenger: 'TRAVELLER PERSON',
      provider: 'IRCTC',
      class: 'CHAIR CAR',
      status: 'CNF',
      quota: 'GENERAL',
    },
    critical: ['pnr', 'service', 'date', 'passenger', 'coach', 'seat'],
    // A chair car has seats, not berths — inventing a berth position would be a
    // fabrication, and this ticket has no barcode to transplant.
    absent: ['berthPosition'],
  },

  // A MakeMyTrip hotel voucher. The first stay tested, and the first document with no
  // origin and no destination — which is why rail.js declines lodging rather than
  // inventing two stations for it.
  //
  // Three shapes here appear nowhere else:
  //  1. The guest's name *precedes* its own label — "Mr. Sample R (Primary Guest)" —
  //     so every label search in the codebase looks the wrong way and finds nothing.
  //  2. Check-in and check-out are side-by-side columns with the date on one line and
  //     the time on the next, so a time must be read from the label's own column or
  //     check-out silently inherits check-in's.
  //  3. Three telephone numbers are printed: the agent's, the guest's own mobile, and
  //     the property's. Only the last is any use to someone standing outside at night.
  'mmt-hotel': {
    adapter: 'lodging',
    type: 'lodging',
    fields: {
      property: 'Sample Resort And Spa',
      provider: 'MakeMyTrip',
      checkInTime: '13:30',
      checkOutTime: '11:00',
      nights: '4',
      guest: 'SAMPLE',
      party: '2',
      // Distinct from the PNR above, which is the whole point: the property's number and
      // the booking reference are both ten digits, and telling them apart is the job.
      phone: '1234679001',
    },
    critical: ['property', 'checkIn', 'checkOut', 'reference', 'guest'],
  },

  // The same agent, the same kind of stay — and it must be refused.
  //
  // A tax invoice carries the hotel's name, its city, the check-in and check-out dates
  // and the customer's name, so it scores well on every positive signal the lodging
  // adapter has. It is not a booking: MakeMyTrip prints "This is not a valid travel
  // document" on it. Presenting one at a reception desk as though it were a voucher
  // would be worse than useless.
  //
  // This is the sharpest negative fixture in the set precisely because the data on it
  // is genuine.
  'mmt-invoice': {
    rejected: true,
  },
};

for (const [name, expect] of Object.entries(EXPECTATIONS)) {
  const url = new URL(`../tests/fixtures/${name}.json`, import.meta.url);

  let fixture;
  try {
    fixture = JSON.parse(await readFile(url, 'utf8'));
  } catch {
    console.log(`skipped ${name} — no fixture`);
    continue;
  }

  fixture.expect = expect;
  await writeFile(url, `${JSON.stringify(fixture, null, 1)}\n`);

  console.log(expect.rejected
    ? `updated ${name}: asserted this is refused, not read`
    : `updated ${name}: ${Object.keys(expect.fields).length} fields asserted`);
}
