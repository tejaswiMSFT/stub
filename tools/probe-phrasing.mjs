/**
 * Tests whether extraction survives how a ticket is *written*, rather than who wrote it.
 *
 * The concern this exists for, in Tejaswi's words: an operator prints "Passenger Name :
 * Mr. Tejaswi C" today and "Pax Name:" with the value on the next line in two months,
 * and the app must not care. Vendor-specific tuning is a trap — layouts change, and a
 * rule learned from one PDF is a rule that breaks on its successor.
 *
 * So every case here is the *same booking*, written differently. Any failure is a gap in
 * the general reader, not a missing vendor.
 *
 * Deliberately not tied to real operators. Naming them would invite exactly the anchoring
 * this is meant to prevent.
 */

import { extract } from '../js/adapters/index.js';
import { buildLines } from '../js/text.js';

function layout(lines, { width = 595, lineHeight = 16, top = 60 } = {}) {
  const items = [];
  lines.forEach((line, row) => {
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

/** The same flight, every time. Only the wording and the geometry change. */
const WANT = {
  passenger: /TEJASWI/i,
  origin: 'BLR',
  destination: 'DEL',
  service: /6E\s*2134/i,
  pnr: /Q7XK2M/i,
};

const CASES = [
  {
    name: 'label and value on one line, with a colon',
    lines: [
      'BOARDING PASS',
      'Passenger Name : Mr. Tejaswi C',
      'From : BLR      To : DEL',
      'Flight : 6E 2134',
      'PNR : Q7XK2M',
      'Date : 16 Sep 2026     Departs : 14:35',
    ],
  },
  {
    name: 'value on the line below, no colon',
    lines: [
      'BOARDING PASS',
      'PASSENGER NAME',
      'TEJASWI C',
      'FROM        TO',
      'BLR         DEL',
      'FLIGHT       PNR',
      '6E 2134      Q7XK2M',
      'DATE        DEPARTS',
      '16 Sep 2026     14:35',
    ],
  },
  {
    name: 'abbreviated captions — "Pax", "Dep"',
    lines: [
      'E-TICKET',
      'Pax Name:',
      'TEJASWI C',
      'From: BLR    To: DEL',
      'Flight No: 6E 2134',
      'Booking Ref: Q7XK2M',
      'Dep: 16 Sep 2026 14:35',
    ],
  },
  {
    name: 'lower case throughout',
    lines: [
      'e-ticket',
      'passenger name: mr tejaswi c',
      'from: blr   to: del',
      'flight: 6E 2134',
      'pnr: Q7XK2M',
      'date: 16 sep 2026   departs: 14:35',
    ],
  },
  {
    name: 'side by side, no colon anywhere',
    lines: [
      'BOARDING PASS',
      'PASSENGER NAME      TEJASWI C',
      'BOOKING REFERENCE     Q7XK2M',
      'FLIGHT NUMBER      6E 2134',
      'ORIGIN         BLR',
      'DESTINATION       DEL',
      'DEPARTURE        16 Sep 2026 14:35',
    ],
  },
  {
    name: 'a header row with values beneath, table style',
    lines: [
      'ELECTRONIC TICKET',
      'PASSENGER      FLIGHT     FROM    TO     PNR',
      'TEJASWI C      6E 2134     BLR     DEL     Q7XK2M',
      'DEPARTS       ARRIVES',
      '16 Sep 2026 14:35   16 Sep 2026 17:05',
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

  console.log(`\n${'-'.repeat(70)}\n${testCase.name}`);

  if (error) {
    console.log(`  REFUSED: ${error.message}`);
    failures += 1;
    continue;
  }

  const got = {
    passenger: draft.value('passenger'),
    origin: draft.value('origin'),
    destination: draft.value('destination'),
    service: draft.value('service') || draft.value('flight'),
    pnr: draft.value('pnr') || draft.value('reference'),
  };

  const wrong = Object.entries(WANT)
    .filter(([key, want]) => {
      const value = got[key] ?? '';
      return want instanceof RegExp ? !want.test(value) : value !== want;
    })
    .map(([key, want]) => `${key}: wanted ${want}, got ${got[key] || '(nothing)'}`);

  if (wrong.length) {
    console.log(`  ${JSON.stringify(got)}`);
    console.log(`  WRONG:\n    ${wrong.join('\n    ')}`);
    failures += 1;
  } else {
    console.log(`  all five vitals read: ${JSON.stringify(got)}`);
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(failures
  ? `${failures} of ${CASES.length} phrasings failed`
  : `all ${CASES.length} phrasings read correctly`);
process.exit(failures ? 1 : 0);
