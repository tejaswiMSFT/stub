/**
 * Decoder verification. Records are constructed field-by-field to IATA Res 792 widths,
 * so a width regression in the decoder fails loudly here rather than silently
 * mis-attributing a value in the UI.
 */
import { decodeBCBP, parseName, resolveJulianDate, normaliseFlightNumber } from '../js/bcbp.js';

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}

const pad = (s, n) => String(s).padEnd(n, ' ').slice(0, n);

function buildLeg({ pnr, from, to, carrier, flight, julian, compartment, seat, sequence, status }) {
  return pad(pnr, 7) + pad(from, 3) + pad(to, 3) + pad(carrier, 3) +
         pad(flight, 5) + pad(julian, 3) + pad(compartment, 1) +
         pad(seat, 4) + pad(sequence, 5) + pad(status, 1);
}

function conditionalBlock() {
  const unique = pad('0', 1) + pad('W', 1) + pad('W', 1) + pad('6259', 4) + pad('B', 1) + pad('6E', 3);
  const repeated = pad('312', 3) + pad('3456789012', 10) + pad('', 1) + pad('0', 1) +
                   pad('6E', 3) + pad('6E', 3) + pad('1234567890', 16) + pad('', 1) + pad('15K', 3);
  const airlineUse = 'LX58ZDEF';
  const body = '>' + '5' +
               unique.length.toString(16).toUpperCase().padStart(2, '0') + unique +
               repeated.length.toString(16).toUpperCase().padStart(2, '0') + repeated +
               airlineUse;
  return body.length.toString(16).toUpperCase().padStart(2, '0') + body;
}

// Reference pass: IndiGo 6E 5306, BLR -> IXE, 16 Sep 2026, seat 10F, PNR QP4RT9
const reference =
  'M' + '1' + pad('C/SAMPLE MR', 20) + 'E' +
  buildLeg({ pnr: 'QP4RT9', from: 'BLR', to: 'IXE', carrier: '6E', flight: '5306',
             julian: '259', compartment: 'Y', seat: '010F', sequence: '0025', status: '1' }) +
  conditionalBlock() +
  '^160MEUCIQTESTSIGNATUREDATA';

console.log('\nReference boarding pass (single leg)');
const r = decodeBCBP(reference, { reference: new Date('2026-08-08T00:00:00Z') });

check('is valid', r.valid, true);
check('format', r.format, 'M');
check('version', r.version, '5');
check('eTicket', r.eTicket, true);
check('leg count', r.legCount, 1);
check('surname', r.name.last, 'C');
check('given name', r.name.first, 'SAMPLE');
check('title', r.name.title, 'MR');
check('pretty name', r.name.displayPretty, 'Sample C');
check('not truncated', r.name.truncated, false);

const leg = r.legs[0];
check('PNR', leg.pnr, 'QP4RT9');
check('from', leg.from, 'BLR');
check('to', leg.to, 'IXE');
check('carrier', leg.carrier, '6E');
check('flight number normalised', leg.flightNumber, '5306');
check('seat normalised', leg.seat, '10F');
check('sequence normalised', leg.sequence, '25');
check('compartment', leg.compartment, 'Y');
check('cabin resolved', leg.cabin, 'Economy');
check('passenger status', leg.passengerStatus, '1');
check('status label', leg.passengerStatusLabel, 'Ticket issuance/passenger checked in');
check('flight date', leg.date.date.toISOString().slice(0, 10), '2026-09-16');
check('date plausible', leg.date.plausible, true);
check('date anchored to issue date', leg.date.anchoredToIssueDate, true);
check('anchored date is not merely inferred', leg.date.yearInferred, false);
check('anchored date confidence', leg.date.confidence, 'high');

check('check-in source', leg.checkInSource, 'W');
check('check-in source label', leg.checkInSourceLabel, 'Web');
check('issuer', leg.boardingPassIssuer, '6E');
check('issue date', leg.issueDateResolved.date.toISOString().slice(0, 10), '2026-09-16');
check('airline numeric code', leg.airlineNumericCode, '312');
check('document serial', leg.documentSerialNumber, '3456789012');
check('marketing carrier', leg.marketingCarrier, '6E');
check('frequent flyer number', leg.frequentFlyerNumber, '1234567890');
check('baggage allowance', leg.freeBaggageAllowance, '15K');
check('airline private use', leg.airlineUse, 'LX58ZDEF');
check('security data type', r.securityData.type, '1');
check('no warnings', r.warnings, []);
check('offsets recorded for PNR', typeof leg.offsets.pnr.start, 'number');

// Multi-leg
console.log('\nMulti-leg record');
const multi =
  'M' + '2' + pad('SHARMA/PRIYA MS', 20) + 'E' +
  buildLeg({ pnr: 'ABC123', from: 'DEL', to: 'DXB', carrier: 'EK', flight: '0511',
             julian: '045', compartment: 'J', seat: '004A', sequence: '0001', status: '3' }) + '00' +
  buildLeg({ pnr: 'ABC123', from: 'DXB', to: 'LHR', carrier: 'EK', flight: '0001',
             julian: '045', compartment: 'J', seat: '012K', sequence: '0002', status: '3' }) + '00';

const m = decodeBCBP(multi, { reference: new Date('2026-02-01T00:00:00Z') });
check('valid', m.valid, true);
check('two legs decoded', m.legs.length, 2);
check('leg 1 route', `${m.legs[0].from}-${m.legs[0].to}`, 'DEL-DXB');
check('leg 2 route', `${m.legs[1].from}-${m.legs[1].to}`, 'DXB-LHR');
check('leg 2 flight number strips padding', m.legs[1].flightNumber, '1');
check('leg 1 cabin', m.legs[0].cabin, 'Business');
check('leg 2 seat', m.legs[1].seat, '12K');
check('shared PNR', m.legs[0].pnr === m.legs[1].pnr, true);

// Degradation: malformed and truncated input must not throw
console.log('\nMalformed input handling');
check('empty input', decodeBCBP('').valid, false);
check('null input', decodeBCBP(null).valid, false);
check('wrong format code', decodeBCBP('X1SOMETHING').valid, false);
check('wrong format is explained',
  decodeBCBP('X1SOMETHING').warnings[0].includes('expected IATA format'), true);

const truncated = reference.slice(0, 45);
const t = decodeBCBP(truncated, { reference: new Date('2026-08-08T00:00:00Z') });
check('truncated does not throw', typeof t, 'object');
check('truncated salvages the name', t.name.last, 'C');
check('truncated is flagged invalid', t.valid, false);

const noConditional =
  'M' + '1' + pad('DOE/JOHN', 20) + 'E' +
  buildLeg({ pnr: 'XYZ999', from: 'JFK', to: 'SFO', carrier: 'UA', flight: '0234',
             julian: '100', compartment: 'Y', seat: '021C', sequence: '0110', status: '1' }) + '00';
const n = decodeBCBP(noConditional, { reference: new Date('2026-04-10T00:00:00Z') });
check('minimal record is valid', n.valid, true);
check('minimal record route', `${n.legs[0].from}-${n.legs[0].to}`, 'JFK-SFO');
check('minimal record seat', n.legs[0].seat, '21C');

// Unit-level edge cases
console.log('\nField normalisation');
check('flight number keeps alpha suffix', normaliseFlightNumber('0123A'), '123A');
check('flight number strips zeros', normaliseFlightNumber('0007 '), '7');
check('name without title', parseName('SMITH/JANE         ').title, '');
check('name detects truncation', parseName('VERYLONGSURNAME/JOHN').truncated, true);

const dec31 = resolveJulianDate('365', new Date('2026-12-30T00:00:00Z'));
check('year-end day resolves', dec31.date.toISOString().slice(0, 10), '2026-12-31');
const janFirst = resolveJulianDate('001', new Date('2026-12-30T00:00:00Z'));
check('new-year rollover picks nearest year', janFirst.date.toISOString().slice(0, 10), '2027-01-01');
check('invalid julian returns null', resolveJulianDate('999'), null);
check('distant date flagged implausible',
  resolveJulianDate('180', new Date('2026-12-20T00:00:00Z')).plausible, false);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
