/**
 * Tests the adapters against documents they have never seen.
 *
 * The charge is overfitting: that extraction works on the handful of tickets used to
 * build it and nothing else. That is a fair thing to suspect — every fixture in the suite
 * came from one person's inbox, and an adapter tuned against a fixture will pass its own
 * fixture forever.
 *
 * So these are transcribed from real tickets issued by operators and agents the code has
 * never been shown: an ixigo-issued IRCTC slip, an IndiGo ticket issued by a travel
 * agency, an AirAsia ticket issued through Traveloka, and an Emirates receipt. The
 * layouts are theirs, not mine. Nothing here was consulted while writing the adapters.
 *
 * Text layers only. Whether a *scan* can be read is a separate question with a separate
 * answer (there is no OCR), and mixing the two would let a failure of one hide behind the
 * other.
 */

import { extract } from '../js/adapters/index.js';
import { buildLines } from '../js/text.js';

/** Turns plain lines into the positioned text items the pipeline expects. */
function layout(lines, { width = 595, lineHeight = 16, top = 60 } = {}) {
  const items = [];
  lines.forEach((line, row) => {
    // Columns separated by two or more spaces, positioned by character offset — which is
    // how a real PDF's text layer arrives, and what the column splitter is built to read.
    let column = 0;
    for (const part of line.split(/(\s{2,})/)) {
      if (/^\s+$/.test(part)) { column += part.length; continue; }
      if (part) {
        items.push({
          text: part,
          x: 40 + column * 5.2,
          y: top + row * lineHeight,
          width: part.length * 5.2,
          height: 11,
        });
      }
      column += part.length;
    }
  });
  return { items, width };
}

const CASES = [
  {
    name: 'IRCTC slip issued by ixigo',
    expect: { kind: 'rail', origin: 'UMB', destination: 'DEOS', service: '15708/ASR KIR EXPRESS', pnr: '2364927203' },
    lines: [
      'Electronic Reservation Slip          IRCTCs e-Ticketing Service (Agent)',
      '',
      'PNR No. : 2364927203        Train No. & Name : 15708/ASR KIR EXPRESS      Quota : General (GN)',
      'Transaction ID: 3RJ4TWXGITZCNF81RH     Date & Time of Booking: 2019-07-13 11:30:00    Class of Travel: Sleeper Class (SL)',
      'From: Ambala Cant Jn (UMB)        Date of Journey: 2019-10-11        To : Deoria Sadar (DEOS)',
      'Boarding: Ambala Cant Jn (UMB)      Date of Boarding: 2019-10-11      Scheduled Departure: 12:00 *',
      'Resv. Up to : Deoria Sadar (DEOS)     Scheduled Arrival: 2019-10-12 06:48 *     1 Adult,0 Children',
      'Passenger Mobile No : 9794998703      Note:- N/A        Distance: 1030.0 km(s)',
      'Ixigo Booking Id : IXITR116159602191',
      '',
      'Passenger Details',
      'S No.   Name              Age   Sex        Booking Status     Current Status',
      '1     RAMPRATAP YADAV         27   Male (M)     CNF/S9/65/LB      CNF/S9/65/LB',
    ],
  },
  {
    name: 'IndiGo ticket issued by a travel agency',
    expect: { kind: 'flight', origin: 'DEL', destination: 'MAA' },
    lines: [
      'E-Ticket',
      'LVI HOLIDAYS LLP(AIR)',
      '33 NETAJI SUBHASH MARG, DARYA GANJ, New Delhi',
      'Issued Date: 31 Jul 2024, Wed',
      '',
      'PNR No.        Departure          Arrival',
      'DEL - MAA   6E - Q4L1NN     31-Jul-2024 9:30 PM, Wed    01-Aug-2024 12:20 AM, Thu',
      '',
      'Passenger Name        Passenger Type',
      'Mr MD SHAUKAT ALAM       Adult',
      'Mr ALANOOR ALANOOR       Adult',
      '',
      'Flight Details      Departure         Arrival        Status',
      'IndiGo 6E 5375     DEL           MAA         Confirmed',
      'Class: RT       (Indira Gandhi Airport, Delhi)  (Chennai International Airport, Chennai)',
      'Aircraft: 321     Terminal: 3        Terminal: 1',
      'Cabin: Economy     31-Jul-2024 9:30 PM, Wed    01-Aug-2024 12:20 AM, Thu',
    ],
  },
  {
    name: 'AirAsia ticket issued through Traveloka',
    expect: { kind: 'flight', origin: 'KCH', destination: 'KUL' },
    lines: [
      'E-ticket',
      'Departure Flight',
      '',
      'AirAsia        Thursday, 18 May 2023        Traveloka Booking ID',
      'AK-5233        11:25  Kuching (KCH)        1021528982',
      'Subclass Z ( Economy )    Kuching International Airport',
      '            13:10  Kuala Lumpur (KUL)      Airline Booking Code (PNR)',
      '            Kuala Lumpur International Airport - Terminal KLIA2',
      '',
      'No.   Passenger(s)              Route      Flight Facilities',
      '1    Mr. DEMBER WILLIAM UNSA (Adult)      KCH - KUL    Baggage 0 kg',
    ],
  },
  {
    name: 'Emirates e-ticket receipt',
    expect: { kind: 'flight', origin: 'DOH', destination: 'IST' },
    lines: [
      'e-Ticket Receipt & Itinerary',
      'Emirates',
      '',
      'PASSENGER NAME       LARRY JOHNSON',
      'BOOKING REFERENCE     DDY37W',
      'E-TICKET NUMBER      138 3012574759',
      'ISSUED BY / DATE      DUBAI EMIRATES IBE',
      '',
      'TRAVEL INFORMATION',
      'FLIGHT   DEPARTURE/ARRIVE   AIRPORT/TERMINAL     CHECK-IN OPENS   CLASS',
      'EK 241   26 OCT 21      HAMAD INTL (DOH)     26 OCT 21     ECONOMY',
      'CONFIRMED  1427        TERMINAL 2       1300       SEAT',
      '      26 OCT 21      INSTANBUL AP (IST)',
      '      1907        TERMINAL 1',
    ],
  },
];

let failures = 0;

for (const testCase of CASES) {
  const { items, width } = layout(testCase.lines);
  const lines = buildLines(items, { pageWidth: width });

  let draft = null;
  let error = null;
  try {
    draft = await extract({ lines, barcode: null, ingested: {} });
  } catch (e) {
    error = e;
  }

  console.log(`\n${'='.repeat(72)}\n${testCase.name}`);

  if (error) {
    console.log(`  REFUSED: ${error.message}`);
    failures += 1;
    continue;
  }

  const got = {
    kind: draft.type,
    origin: draft.value('origin'),
    destination: draft.value('destination'),
    service: draft.value('service') || draft.value('flight'),
    date: draft.value('date'),
    departureTime: draft.value('departureTime'),
    passenger: draft.value('passenger'),
    pnr: draft.value('pnr') || draft.value('reference'),
    seat: draft.value('seat'),
  };

  console.log(`  read as: ${JSON.stringify(got)}`);

  const wrong = Object.entries(testCase.expect)
    .filter(([key, want]) => got[key] !== want)
    .map(([key, want]) => `${key}: wanted ${want}, got ${got[key] ?? '(nothing)'}`);

  if (wrong.length) {
    console.log(`  WRONG:\n    ${wrong.join('\n    ')}`);
    failures += 1;
  } else {
    console.log('  correct on every checked field');
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log(failures ? `${failures} of ${CASES.length} unseen tickets failed` : `all ${CASES.length} unseen tickets read correctly`);
process.exit(failures ? 1 : 0);
