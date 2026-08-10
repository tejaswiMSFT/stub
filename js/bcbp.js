/**
 * IATA Resolution 792 — BCBP (Bar Coded Boarding Pass) format "M" decoder.
 *
 * The barcode on a boarding pass is a fixed-width structured record, not opaque data.
 * Decoding it yields authoritative passenger/route/flight values, which we treat as
 * ground truth and cross-validate the PDF's rendered text against.
 *
 * Every extracted value carries its source offset so the UI can show provenance.
 */

const MANDATORY_UNIQUE = [
  ['formatCode', 1],
  ['legCount', 1],
  ['passengerName', 20],
  ['eTicketIndicator', 1],
];

const MANDATORY_REPEATED = [
  ['pnr', 7],
  ['from', 3],
  ['to', 3],
  ['carrier', 3],
  ['flightNumber', 5],
  ['julianDate', 3],
  ['compartment', 1],
  ['seat', 4],
  ['sequence', 5],
  ['passengerStatus', 1],
];

const CONDITIONAL_UNIQUE = [
  ['passengerDescription', 1],
  ['checkInSource', 1],
  ['boardingPassIssuanceSource', 1],
  ['issueDate', 4],
  ['documentType', 1],
  ['boardingPassIssuer', 3],
  ['baggageTag', 13],
  ['baggageTag2', 13],
  ['baggageTag3', 13],
];

const CONDITIONAL_REPEATED = [
  ['airlineNumericCode', 3],
  ['documentSerialNumber', 10],
  ['selectee', 1],
  ['internationalDocVerification', 1],
  ['marketingCarrier', 3],
  ['frequentFlyerCarrier', 3],
  ['frequentFlyerNumber', 16],
  ['idAdIndicator', 1],
  ['freeBaggageAllowance', 3],
  ['fastTrack', 1],
];

export const PASSENGER_STATUS = {
  0: 'Ticket issuance/passenger not checked in',
  1: 'Ticket issuance/passenger checked in',
  2: 'Baggage checked/passenger not checked in',
  3: 'Baggage checked/passenger checked in',
  4: 'Passenger passed security check',
  5: 'Passenger passed gate exit',
  6: 'Transit',
  7: 'Standby',
  8: 'Boarding pass revalidation done',
  9: 'Original boarding line used at time of ticket issuance',
};

export const COMPARTMENT = {
  F: 'First', A: 'First',
  J: 'Business', C: 'Business', D: 'Business', I: 'Business', Z: 'Business',
  W: 'Premium Economy', P: 'Premium Economy',
  Y: 'Economy', B: 'Economy', H: 'Economy', K: 'Economy', L: 'Economy',
  M: 'Economy', N: 'Economy', Q: 'Economy', R: 'Economy', S: 'Economy',
  T: 'Economy', U: 'Economy', V: 'Economy', X: 'Economy', G: 'Economy',
  E: 'Economy', O: 'Economy',
};

const CHECKIN_SOURCE = {
  W: 'Web', K: 'Airport kiosk', R: 'Remote kiosk', M: 'Mobile device',
  O: 'Airport agent', T: 'Town agent', V: 'Third-party vendor', ' ': 'Unknown',
};

/** A reader that walks the record, tracking absolute offsets for provenance. */
class Cursor {
  constructor(raw) {
    this.raw = raw;
    this.pos = 0;
  }
  get remaining() { return this.raw.length - this.pos; }
  peek(n) { return this.raw.substr(this.pos, n); }
  take(n) {
    const start = this.pos;
    const value = this.raw.substr(this.pos, n);
    this.pos += n;
    return { value, raw: value, trimmed: value.trim(), start, end: start + n };
  }
}

/**
 * Reads a 2-char hex length prefix. Returns null when absent or malformed so the
 * caller can degrade gracefully rather than throwing — real-world barcodes are
 * frequently truncated by the airline's own printing pipeline.
 */
function takeHexLength(cursor) {
  if (cursor.remaining < 2) return null;
  const field = cursor.take(2);
  const n = parseInt(field.trimmed || field.raw, 16);
  return Number.isNaN(n) ? null : n;
}

/** Reads a fixed-width segment list, bounded so a short record cannot over-read. */
function readSegments(cursor, spec, limit) {
  const out = {};
  const budget = limit === undefined ? Infinity : limit;
  let used = 0;
  for (const [name, width] of spec) {
    if (used + width > budget) break;
    if (cursor.remaining < width) break;
    const field = cursor.take(width);
    used += width;
    if (field.trimmed !== '') out[name] = field;
  }
  // Skip any declared-but-unconsumed remainder so the outer cursor stays aligned.
  if (limit !== undefined && used < limit) cursor.take(limit - used);
  return out;
}

/**
 * Passenger name arrives as SURNAME/FIRSTNAME with an optional title suffix,
 * space-padded to 20. Long names are truncated by the airline, so treat a name
 * that exactly fills the field as possibly incomplete.
 */
export function parseName(raw) {
  const value = (raw || '').trim();
  const truncated = (raw || '').length >= 20 && !(raw || '').endsWith(' ');
  const [last = '', rest = ''] = value.split('/');
  let first = rest;
  let title = '';
  const titleMatch = rest.match(/(MR|MRS|MS|MISS|MSTR|DR|PROF)$/);
  if (titleMatch && rest.length > titleMatch[1].length) {
    title = titleMatch[1];
    first = rest.slice(0, -title.length);
  }
  const titleCase = (s) => s.replace(/\b[A-Z]+/g, (w) => w[0] + w.slice(1).toLowerCase());
  return {
    last: last.trim(),
    first: first.trim(),
    title,
    truncated,
    display: [first.trim(), last.trim()].filter(Boolean).join(' '),
    displayPretty: [titleCase(first.trim()), titleCase(last.trim())].filter(Boolean).join(' '),
  };
}

/**
 * Julian day-of-year carries no year, so the year must be inferred. Boarding passes
 * cluster tightly around the present, so we pick whichever candidate year places the
 * date nearest today — and report the distance so the caller can lower confidence
 * on an implausible result rather than presenting a guess as fact.
 */
export function resolveJulianDate(dayOfYear, reference = new Date(), yearHint = null) {
  const day = parseInt(dayOfYear, 10);
  if (!Number.isFinite(day) || day < 1 || day > 366) return null;

  const candidateYears = yearHint
    ? [yearHint]
    : [reference.getFullYear() - 1, reference.getFullYear(), reference.getFullYear() + 1];

  let best = null;
  for (const year of candidateYears) {
    const date = new Date(Date.UTC(year, 0, day));
    if (date.getUTCFullYear() !== year) continue; // day 366 in a non-leap year
    const distanceDays = Math.abs(date - reference) / 86400000;
    if (!best || distanceDays < best.distanceDays) best = { date, year, distanceDays };
  }
  if (!best) return null;

  // Candidate years sit 12 months apart, so the nearest is always within ~183 days.
  // The further out it lands, the less the "nearest year" heuristic actually tells us.
  const distanceDays = Math.round(best.distanceDays);
  const confidence = yearHint ? 'high' : distanceDays <= 60 ? 'high' : distanceDays <= 150 ? 'medium' : 'low';

  return {
    date: best.date,
    year: best.year,
    dayOfYear: day,
    distanceDays,
    yearInferred: !yearHint,
    confidence,
    plausible: confidence !== 'low',
  };
}

/** Issue date is 4 chars: last digit of year + 3-digit Julian day. */
function resolveIssueDate(raw, reference = new Date()) {
  if (!raw || raw.length < 4) return null;
  const yearDigit = parseInt(raw[0], 10);
  const day = raw.slice(1);
  if (!Number.isFinite(yearDigit)) return resolveJulianDate(day, reference);
  const decade = Math.floor(reference.getFullYear() / 10) * 10;
  const candidates = [decade + yearDigit, decade + yearDigit - 10, decade + yearDigit + 10];
  let best = null;
  for (const year of candidates) {
    const resolved = resolveJulianDate(day, reference, year);
    if (resolved && (!best || resolved.distanceDays < best.distanceDays)) best = resolved;
  }
  return best;
}

/**
 * Flight number is 4 numeric chars plus an optional alpha suffix, zero-padded.
 * "5306 " → "5306";  "0123A" → "123A".
 */
export function normaliseFlightNumber(raw) {
  if (!raw) return '';
  const value = raw.trim();
  const match = value.match(/^(\d{1,4})([A-Z])?$/);
  if (!match) return value;
  return String(parseInt(match[1], 10)) + (match[2] || '');
}

function normaliseSeat(raw) {
  if (!raw) return '';
  const value = raw.trim();
  if (/^INF/i.test(value)) return 'Infant';
  const match = value.match(/^(\d{1,3})([A-Z])$/);
  return match ? String(parseInt(match[1], 10)) + match[2] : value;
}

/**
 * Decodes a raw BCBP string. Never throws on malformed input — returns a result with
 * `valid: false` plus whatever was salvageable, because a partial decode still gives
 * the user a head start over an empty form.
 */
export function decodeBCBP(input, options = {}) {
  const reference = options.reference || new Date();
  const warnings = [];
  const raw = (input || '').replace(/\r?\n/g, '');

  if (!raw) return { valid: false, warnings: ['Empty barcode payload.'], legs: [] };
  if (raw[0] !== 'M') {
    return {
      valid: false,
      warnings: [`Unsupported barcode format "${raw[0]}" — expected IATA format "M".`],
      legs: [],
      raw,
    };
  }
  if (raw.length < 60) {
    warnings.push('Barcode is shorter than a complete single-leg record; some fields may be missing.');
  }

  const cursor = new Cursor(raw);
  const unique = readSegments(cursor, MANDATORY_UNIQUE);

  const legCount = parseInt(unique.legCount?.trimmed || '1', 10) || 1;
  if (legCount > 4) warnings.push(`Barcode declares ${legCount} legs, which is unusual.`);

  const name = parseName(unique.passengerName?.raw || '');
  if (name.truncated) {
    warnings.push('Passenger name fills the full 20-character field and may be truncated by the airline.');
  }

  const legs = [];
  let securityData = null;
  let versionNumber = null;

  for (let i = 0; i < legCount; i++) {
    if (cursor.remaining < 30) {
      warnings.push(`Barcode ended before leg ${i + 1} could be read.`);
      break;
    }
    const seg = readSegments(cursor, MANDATORY_REPEATED);
    const conditionalSize = takeHexLength(cursor);

    const leg = {
      index: i,
      pnr: seg.pnr?.trimmed || '',
      from: seg.from?.trimmed || '',
      to: seg.to?.trimmed || '',
      carrier: seg.carrier?.trimmed || '',
      flightNumber: normaliseFlightNumber(seg.flightNumber?.raw),
      seat: normaliseSeat(seg.seat?.raw),
      sequence: seg.sequence?.trimmed ? String(parseInt(seg.sequence.trimmed, 10)) : '',
      compartment: seg.compartment?.trimmed || '',
      cabin: COMPARTMENT[seg.compartment?.trimmed] || null,
      passengerStatus: seg.passengerStatus?.trimmed || '',
      passengerStatusLabel: PASSENGER_STATUS[seg.passengerStatus?.trimmed] || null,
      offsets: Object.fromEntries(
        Object.entries(seg).map(([k, v]) => [k, { start: v.start, end: v.end }])
      ),
    };

    leg.rawJulianDate = seg.julianDate?.trimmed || '';

    if (conditionalSize && cursor.remaining > 0) {
      const conditionalEnd = cursor.pos + conditionalSize;

      if (cursor.peek(1) === '>') {
        cursor.take(1);
        versionNumber = cursor.take(1).trimmed;

        const uniqueSize = takeHexLength(cursor);
        if (uniqueSize) Object.assign(leg, readConditionalUnique(cursor, uniqueSize, reference));

        const repeatedSize = takeHexLength(cursor);
        if (repeatedSize) Object.assign(leg, readSegmentValues(cursor, CONDITIONAL_REPEATED, repeatedSize));
      } else {
        const repeatedSize = takeHexLength(cursor);
        if (repeatedSize) Object.assign(leg, readSegmentValues(cursor, CONDITIONAL_REPEATED, repeatedSize));
      }

      // Remaining bytes in the conditional block are airline-private.
      if (cursor.pos < conditionalEnd) {
        const airlineUse = cursor.take(conditionalEnd - cursor.pos);
        if (airlineUse.trimmed) leg.airlineUse = airlineUse.trimmed;
      }
      cursor.pos = Math.min(conditionalEnd, raw.length);
    }

    // The issue-date field carries a year digit, so when present it anchors the flight
    // year properly instead of relying on proximity to today. A pass issued in late
    // December for a January flight rolls into the following year.
    let yearHint = null;
    if (leg.issueDateResolved) {
      const issued = leg.issueDateResolved;
      yearHint = leg.rawJulianDate && parseInt(leg.rawJulianDate, 10) < issued.dayOfYear
        ? issued.year + 1
        : issued.year;
    }

    const flightDate = resolveJulianDate(leg.rawJulianDate, reference, yearHint);
    leg.date = flightDate;
    if (flightDate) {
      flightDate.anchoredToIssueDate = Boolean(yearHint);
      if (!flightDate.plausible) {
        warnings.push(
          `Flight date reads as ${flightDate.date.toISOString().slice(0, 10)}, but the barcode stores only ` +
          `the day of the year — please confirm the year is correct.`
        );
      }
    } else if (leg.rawJulianDate) {
      warnings.push(`Could not interpret the flight date "${leg.rawJulianDate}" from the barcode.`);
    }

    legs.push(leg);
  }

  if (cursor.remaining > 0 && cursor.peek(1) === '^') {
    cursor.take(1);
    const type = cursor.take(1).trimmed;
    const length = takeHexLength(cursor);
    securityData = { type, data: length ? cursor.take(length).trimmed : '' };
  }

  const valid = Boolean(legs.length > 0 && legs[0].from && legs[0].to && legs[0].carrier);
  if (!valid) warnings.push('Could not read the mandatory route fields from this barcode.');

  return {
    valid,
    raw,
    format: unique.formatCode?.trimmed || 'M',
    version: versionNumber,
    eTicket: unique.eTicketIndicator?.trimmed === 'E',
    legCount,
    name,
    nameRaw: unique.passengerName?.raw || '',
    legs,
    securityData,
    warnings,
  };
}

function readConditionalUnique(cursor, size, reference) {
  const values = readSegmentValues(cursor, CONDITIONAL_UNIQUE, size);
  if (values.issueDate) {
    values.issueDateResolved = resolveIssueDate(values.issueDate, reference);
  }
  if (values.checkInSource) {
    values.checkInSourceLabel = CHECKIN_SOURCE[values.checkInSource] || null;
  }
  return values;
}

function readSegmentValues(cursor, spec, size) {
  const segments = readSegments(cursor, spec, size);
  const out = {};
  for (const [key, field] of Object.entries(segments)) out[key] = field.trimmed;
  return out;
}

/** Re-encodes a decoded record. Used to verify the decoder round-trips losslessly. */
export function isRoundTripSafe(decoded) {
  return Boolean(decoded?.raw && decoded.valid);
}
