/**
 * Flight adapter — IATA boarding passes.
 *
 * This is the only adapter with a structured, authoritative source: the BCBP barcode
 * encodes passenger, route, flight, date and seat as fixed-width fields. Those values
 * are facts, not guesses.
 *
 * The PDF text is used for what the barcode cannot carry — gate, terminal, boarding
 * time, scheduled times — and to cross-check the barcode. Where the two agree,
 * confidence rises. Where they disagree, we surface both and let the user decide
 * rather than silently preferring one.
 */

import {
  register, decodeBCBP, Field, Source, Confidence, TicketDraft,
  parseTime, parseDate, toWalletDate, findLabelled, findProvider, toPlainText,
} from './registry.js';
import { splitColumns } from '../text.js';
import { airport } from '../data/airports.js';

const IATA_CODE = /^[A-Z]{3}$/;

/** An airline flight designator: two-character carrier code then one to four digits. */
const FLIGHT_NUMBER = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/;

/** A route printed as a code pair, as itineraries almost always do: "BLR-IXE". */
const SECTOR = /\b([A-Z]{3})\s*[-–—>]\s*([A-Z]{3})\b/;

function detect(context) {
  const payload = context.barcode?.text || '';

  // A BCBP record is unmistakable: 'M' followed by a leg count, then fixed-width data.
  if (/^M[1-9]/.test(payload) && payload.length >= 58) return 100;

  const text = toPlainText(context.lines).toUpperCase();
  let score = 0;

  // A boarding pass says so.
  if (/\bBOARDING\s*PASS\b/.test(text)) score += 40;

  // An itinerary does not, and is far more common as a saved file — nobody keeps the
  // boarding pass they were issued at the gate, but everyone keeps the confirmation
  // email. Recognised by the things only air travel prints.
  if (/\bE-?TICKET\b|\bITINERAR/.test(text)) score += 25;
  if (/\bPNR\b|\bBOOKING\s*REFERENCE\b|\bRECORD\s*LOCATOR\b/.test(text)) score += 15;
  if (FLIGHT_NUMBER.test(text) && /\bFLIGHT\b|\bAIRLINE\b|\bSECTOR\b|\bAIRPORT\b/.test(text)) score += 25;
  if (SECTOR.test(text)) score += 20;
  if (/\bAIRPORT\b/.test(text)) score += 20;
  if (/\bCHECK[-\s]?IN\b/.test(text) && /\bBAG(?:GAGE)?\b|\bCABIN\b/.test(text)) score += 15;
  if (/\bGATE\b/.test(text) && /\bSEAT\b/.test(text)) score += 15;
  if (/\bTERMINAL\b/.test(text)) score += 5;
  if (/\bECONOMY\b|\bBUSINESS\s*CLASS\b|\bPREMIUM\s*ECONOMY\b/.test(text)) score += 10;
  if (/\bAVIATION\b|\bAIRFARE\b|\bFLIGHT\s*SUMMARY\b/.test(text)) score += 15;

  return score >= 40 ? Math.min(score, 90) : 0;
}

/**
 * Cross-checks a barcode value against the PDF text.
 *
 * Agreement is the strongest signal available to us — two independent representations
 * of the same fact. Disagreement usually means the PDF was updated after the barcode
 * was printed (a gate change, a seat reassignment), which is precisely the case the
 * user must see rather than have decided for them.
 */
function corroborate(field, textValue, { normalise = (v) => v } = {}) {
  if (!textValue || !field.value) return field;

  const a = normalise(String(field.value)).toUpperCase().trim();
  const b = normalise(String(textValue)).toUpperCase().trim();

  if (a === b) return field.corroborate(Source.PDF_TEXT);
  return field.conflict(textValue, Source.PDF_TEXT);
}

function buildRouteFields(draft, leg, lines) {
  // The date matters: an airport's UTC offset depends on whether daylight saving is
  // in force on the day of travel, not on the day the pass happens to be built.
  const on = leg.date?.date || new Date();
  const from = airport(leg.from, { on });
  const to = airport(leg.to, { on });

  const origin = draft.set('origin', new Field({
    key: 'origin',
    label: 'From',
    value: leg.from,
    source: Source.BARCODE,
    required: true,
    critical: true,
  }));
  const destination = draft.set('destination', new Field({
    key: 'destination',
    label: 'To',
    value: leg.to,
    source: Source.BARCODE,
    required: true,
    critical: true,
  }));

  if (from) origin.note = from.city ? `${from.city}${from.name ? ` — ${from.name}` : ''}` : from.name;
  else origin.warn('This airport code is not one we recognise.', 'unknown-airport');

  if (to) destination.note = to.city ? `${to.city}${to.name ? ` — ${to.name}` : ''}` : to.name;
  else destination.warn('This airport code is not one we recognise.', 'unknown-airport');

  // The PDF usually prints the codes too; agreement confirms we read the right record.
  const printed = toPlainText(lines).toUpperCase();
  if (printed.includes(leg.from)) origin.corroborate(Source.PDF_TEXT);
  if (printed.includes(leg.to)) destination.corroborate(Source.PDF_TEXT);

  return { from, to };
}

function buildTimeFields(draft, leg, lines, airports) {
  const printedDate = findLabelled(lines, [
    /\b(?:date\s*of\s*(?:travel|journey)|travel\s*date|flight\s*date|date)\b/i,
  ]);

  const dateField = draft.set('date', new Field({
    key: 'date',
    label: 'Date',
    value: leg.date ? leg.date.date.toISOString().slice(0, 10) : '',
    source: leg.date ? Source.BARCODE : Source.INFERRED,
    type: 'date',
    required: true,
    critical: true,
    region: printedDate?.region || null,
  }));

  // The barcode stores only a day-of-year, so the year is either anchored to the
  // issue-date field or inferred. An inferred year is explicitly not a fact.
  if (leg.date && !leg.date.anchoredToIssueDate) {
    dateField.confidence = leg.date.confidence === 'high' ? Confidence.MEDIUM : Confidence.LOW;
    dateField.warn(
      'The barcode records only the day of the year, so the year is worked out. Please confirm it.',
      'inferred-year',
    );
  }

  if (printedDate) {
    const parsed = parseDate(printedDate.value);
    if (parsed?.date && leg.date) {
      const printedIso = parsed.date.toISOString().slice(0, 10);
      const barcodeIso = leg.date.date.toISOString().slice(0, 10);

      if (printedIso === barcodeIso) {
        dateField.corroborate(Source.PDF_TEXT);
        dateField.issues = dateField.issues.filter((i) => i.code !== 'inferred-year');
      } else if (parsed.hadYear && printedIso.slice(5) === barcodeIso.slice(5)) {
        // Same day and month but a different year: the printed year is authoritative,
        // since the barcode never carried one.
        dateField.autoCorrect(printedIso, 'Year taken from the printed date on your ticket.');
        dateField.confidence = Confidence.HIGH;
        dateField.issues = dateField.issues.filter((i) => i.code !== 'inferred-year');
      } else {
        dateField.conflict(printedIso, Source.PDF_TEXT);
      }
    } else if (parsed?.ambiguous) {
      dateField.warn('The printed date could be read two ways, so the barcode was used.', 'ambiguous-date');
    }
  }

  const departure = findLabelled(lines, [
    /\bdepart(?:s|ure)?(?:\s*time)?\b/i,
    /\bsched(?:uled)?\s*dep\w*\b/i,
    /\bdep\b/i,
  ]);
  const arrival = findLabelled(lines, [/\barriv(?:es|al)?(?:\s*time)?\b/i, /\barr\b/i]);
  const boarding = findLabelled(lines, [
    /\bboarding\s*(?:time|at|starts?)\b/i,
    /\bboarding\b/i,
    /\bgate\s*closes?\b/i,
  ]);

  addTimeField(draft, 'departureTime', 'Departs', departure, airports.from);
  addTimeField(draft, 'arrivalTime', 'Arrives', arrival, airports.to);
  addTimeField(draft, 'boardingTime', 'Boarding', boarding, airports.from);

  // Deliberately no computed "boarding closes" value: the interval varies by airline,
  // airport and fare, so a manufactured figure could cause a genuinely missed flight.
  const boardingField = draft.get('boardingTime');
  if (boardingField && !boardingField.value) {
    boardingField.note = 'Not printed on your ticket — check with your airline.';
  }

  return dateField;
}

function addTimeField(draft, key, label, found, airportInfo) {
  const parsed = found ? parseTime(found.value) : null;

  const field = draft.set(key, new Field({
    key,
    label,
    value: parsed?.text || '',
    source: found ? Source.PDF_TEXT : Source.INFERRED,
    type: 'time',
    region: found?.region || null,
  }));

  if (found && !parsed) {
    field.warn(`We could not read "${found.value}" as a time.`, 'unparsed-time');
    field.confidence = Confidence.LOW;
  }

  // Scheduled times on tickets are local to the airport concerned, so the pass must
  // display them in that zone rather than converting to wherever the phone happens
  // to be. The offset travels with the field for exactly that purpose.
  if (airportInfo?.utcOffsetMinutes !== undefined && airportInfo.utcOffsetMinutes !== null) {
    field.offsetMinutes = airportInfo.utcOffsetMinutes;
    field.timeZone = airportInfo.timeZone || null;
  }

  return field;
}

async function build(context) {
  const { lines, barcode } = context;
  const decoded = barcode?.text ? decodeBCBP(barcode.text) : { valid: false, legs: [], warnings: [] };
  const leg = decoded.legs?.[0] || null;

  const draft = new TicketDraft({
    type: 'flight',
    style: 'boardingPass',
    transitType: 'PKTransitTypeAir',
    adapter: 'flight',
    confidence: decoded.valid ? Confidence.HIGH : Confidence.LOW,
  });

  draft.barcode = barcode;
  draft.warnings.push(...(decoded.warnings || []));
  draft.decoded = decoded;

  if (!leg) {
    // No usable barcode: fall back to text alone, flagged low throughout.
    return buildFromTextOnly(draft, lines);
  }

  // ── Passenger ──
  const printedName = findLabelled(lines, [/\bpassenger(?:\s*name)?\b/i, /\bname\s*of\s*passenger\b/i, /\bname\b/i]);
  const nameField = draft.set('passenger', new Field({
    key: 'passenger',
    label: 'Passenger',
    value: decoded.name.displayPretty || decoded.name.display,
    source: Source.BARCODE,
    required: true,
    critical: true,
    region: printedName?.region || null,
  }));

  if (decoded.name.truncated) {
    nameField.warn('The barcode truncates long names, so this may be shortened.', 'truncated-name');
  }
  if (printedName) {
    // Compare on letters alone — the printed form varies in punctuation and titles.
    const strip = (v) => v.replace(/\b(MR|MRS|MS|MISS|MSTR|DR|PROF)\b/gi, '').replace(/[^A-Z]/gi, '');
    const a = strip(nameField.value);
    const b = strip(printedName.value);
    if (a && b && (a === b || b.includes(a) || a.includes(b))) nameField.corroborate(Source.PDF_TEXT);
  }

  const airports = buildRouteFields(draft, leg, lines);

  // ── Flight ──
  const flightNumber = `${leg.carrier} ${leg.flightNumber}`.trim();
  const flightField = draft.set('flight', new Field({
    key: 'flight',
    label: 'Flight',
    value: flightNumber,
    source: Source.BARCODE,
    required: true,
    critical: true,
  }));
  const printedFlight = findLabelled(lines, [/\bflight(?:\s*(?:no|number|#))?\b/i]);
  if (printedFlight) {
    corroborate(flightField, printedFlight.value, { normalise: (v) => v.replace(/[\s-]/g, '') });
    if (!flightField.region) flightField.region = printedFlight.region;
  }

  // ── Seat ──
  //
  // The barcode's seat field is not always populated: an itinerary issued before check-in
  // carries a placeholder, and IATA's fixed-width format means that placeholder arrives
  // as plausible-looking characters rather than as nothing. So a printed seat is
  // preferred whenever the barcode's is not a well-formed seat number.
  const printedSeat = findLabelled(lines, [/\bseat(?:\s*(?:no|number))?\b/i]);
  const printedSeatValue = cleanSeat(printedSeat?.value);
  const barcodeSeat = leg.seat === 'Infant' ? '' : cleanSeat(leg.seat);

  const seatField = draft.set('seat', new Field({
    key: 'seat',
    label: 'Seat',
    value: barcodeSeat || printedSeatValue || '',
    source: barcodeSeat ? Source.BARCODE : (printedSeatValue ? Source.PDF_TEXT : Source.INFERRED),
    region: printedSeat?.region || null,
  }));

  if (barcodeSeat && printedSeatValue) {
    corroborate(seatField, printedSeatValue, { normalise: (v) => v.replace(/\s/g, '') });
  } else if (!barcodeSeat && printedSeatValue) {
    seatField.note = 'Taken from the printed ticket — the barcode had no seat recorded.';
  }

  if (leg.seat === 'Infant') seatField.note = 'Travelling as an infant — no seat assigned.';

  // ── Booking reference ──
  const pnrField = draft.set('pnr', new Field({
    key: 'pnr',
    label: 'Booking ref',
    value: leg.pnr,
    source: Source.BARCODE,
    required: true,
    critical: true,
  }));
  const printedPnr = findLabelled(lines, [
    /\b(?:pnr|booking\s*(?:ref\w*|code|id)|record\s*locator|reservation\s*(?:code|number))\b/i,
  ]);
  if (printedPnr) {
    corroborate(pnrField, printedPnr.value.split(/\s/)[0]);
    if (!pnrField.region) pnrField.region = printedPnr.region;
  }

  // ── Times ──
  buildTimeFields(draft, leg, lines, airports);

  // ── Gate and terminal: barcode cannot carry these, so text is the only source ──
  const gate = findLabelled(lines, [/\bgate\b/i]);
  draft.set('gate', new Field({
    key: 'gate',
    label: 'Gate',
    value: gate ? gate.value.split(/\s{2,}/)[0].slice(0, 6) : '',
    source: gate ? Source.PDF_TEXT : Source.INFERRED,
    region: gate?.region || null,
    note: gate ? 'Gates change — always check the airport screens.' : 'Not printed on your ticket.',
  }));

  const terminal = findLabelled(lines, [/\bterminal\b/i, /\bterm\b/i]);
  const terminalValue = cleanTerminal(terminal?.value) || terminalFromAirport(lines, origin?.code);
  draft.set('terminal', new Field({
    key: 'terminal',
    label: 'Terminal',
    value: terminalValue,
    source: terminalValue ? Source.PDF_TEXT : Source.INFERRED,
    region: terminal?.region || null,
  }));

  // ── Cabin and sequence ──
  if (leg.cabin) {
    draft.set('cabin', new Field({
      key: 'cabin', label: 'Class', value: leg.cabin, source: Source.BARCODE,
    }));
  }
  if (leg.sequence) {
    draft.set('sequence', new Field({
      key: 'sequence', label: 'Seq', value: leg.sequence, source: Source.BARCODE,
    }));
  }
  if (leg.frequentFlyerNumber) {
    draft.set('frequentFlyer', new Field({
      key: 'frequentFlyer', label: 'Frequent flyer', value: leg.frequentFlyerNumber, source: Source.BARCODE,
    }));
  }

  // ── Provider ──
  //
  // Taken from the document's own prominent text, but section headings are rejected:
  // "Passenger Information" is set large and near the top of an IndiGo itinerary, and
  // would otherwise be reported as the airline. The carrier code from the barcode is the
  // fallback — "6E" is at least true, and correctable.
  const provider = findProvider(lines);
  const operated = operatingCarrier(lines);
  const looksLikeHeading = provider?.value
    && (/\b(information|details|summary|itinerary|booking|reference)\b/i.test(provider.value)
      || looksLikeSalutation(provider.value));

  const providerValue = operated?.value || (looksLikeHeading ? '' : provider?.value);

  draft.set('provider', new Field({
    key: 'provider',
    label: 'Airline',
    value: providerValue || leg.carrier,
    source: providerValue ? Source.PDF_TEXT : Source.BARCODE,
    confidence: operated ? Confidence.MEDIUM
      : (providerValue ? provider.confidence : Confidence.MEDIUM),
    region: operated?.region || (looksLikeHeading ? null : (provider?.region || null)),
  }));

  // ── Times printed on the ticket ──
  //
  // The barcode carries none: BCBP records the date but never the departure time, so
  // these can only come from the printed page. An itinerary shows them without a caption
  // — "14:35 hrs, 16 Sep 2026" — which no label search will find.
  fillPrintedTimes(draft, lines);

  // ── Onward legs ──
  if (decoded.legs.length > 1) {
    draft.additionalLegs = decoded.legs.slice(1).map((extra) => ({
      from: extra.from,
      to: extra.to,
      flight: `${extra.carrier} ${extra.flightNumber}`.trim(),
      seat: extra.seat,
      date: extra.date?.date?.toISOString().slice(0, 10) || null,
    }));
    draft.warnings.push(
      `This barcode covers ${decoded.legs.length} flights. Wallet shows one flight per pass, ` +
      `so a separate pass is needed for each onward leg.`
    );
  }

  return draft;
}

/**
 * Finds every traveller's name, where nothing labels them.
 *
 * Airlines caption almost everything except the name. IndiGo writes a heading —
 * "Passenger Information" — and puts "Mr SAMPLE R Adult | Male |" beneath it, which no
 * search for the word "passenger" will ever resolve correctly.
 *
 * All matches are returned rather than the first. A single booking reference routinely
 * covers a family, and a pass showing one traveller while quietly discarding the others
 * gives its holder no way to notice that anyone is missing — which they will discover at
 * the desk, with the queue behind them.
 *
 * Two signals, in order of reliability: a title, which is close to conclusive; and
 * position beneath a passenger heading. Deliberately conservative, since a wrong name is
 * worse than a blank one the user is asked to fill.
 */
function findPassengerNames(lines) {
  // Case-insensitive: tickets print "Mr", "MR" and "mr" with equal enthusiasm.
  const TITLE = /\b(?:MR|MRS|MS|MISS|MSTR|MASTER|DR|PROF)\.?\s+([A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,3})/gi;

  // Trailing descriptors airlines append to the name, and the honorific itself — a
  // boarding pass is checked against a passport, which carries no honorific.
  const strip = (value) => value
    .replace(/\s*\|\s*/g, ' ')
    .replace(/^\s*(mr|mrs|ms|miss|mstr|master|dr|prof)\.?\s+/i, '')
    .replace(/\b(adult|child|infant|male|female|senior|citizen)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const found = [];
  const seen = new Set();

  const add = (value, region) => {
    const key = value.toUpperCase();
    if (!value || seen.has(key)) return;
    if (value.length < 2 || value.length > 40) return;
    seen.add(key);
    found.push({ value, region });
  };

  for (const line of lines) {
    for (const match of line.text.matchAll(TITLE)) {
      add(strip(match[1]), line);
    }
  }

  if (found.length) return found;

  // Failing a title, the lines beneath a passenger heading.
  for (let index = 0; index < lines.length; index++) {
    if (!/\bpassenger\s*(information|details|name)\b/i.test(lines[index].text)) continue;

    for (let next = index + 1; next < Math.min(index + 6, lines.length); next++) {
      const value = strip(lines[next].text);
      // A name is short, has no digits, and is not another caption.
      if (!value || value.length > 40 || /\d/.test(value)) continue;
      if (/\b(sector|seat|add-?ons|status|information|details|baggage|fare)\b/i.test(value)) continue;
      if (value.split(/\s+/).length > 5) continue;
      add(value, lines[next]);
    }

    if (found.length) break;
  }

  return found;
}

/**
 * Cleans a terminal designation.
 *
 * Airports print these inside the airport's own name — "Kempegowda International Airport
 * (Terminal 1)" — which wraps, so a label search returns the fragment "1)". A stray
 * bracket on a boarding pass looks like a defect, and the useful part is the identifier.
 */
function cleanTerminal(raw) {
  if (!raw) return '';

  const text = String(raw).replace(/[()]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const match = text.match(/\b(?:terminal\s*)?([0-9]{1,2}[A-Z]?|[A-Z])\b/i);
  return match ? match[1].toUpperCase() : '';
}

/**
 * Reads a terminal out of the airport's printed name.
 *
 * Neither airline tested labels the terminal as a field. IndiGo hides it in brackets
 * after the airport — "Kempegowda International Airport (Terminal 1)" — and Air India
 * Express appends it to the city with a comma: "…Airport Bengaluru,T2". A label search
 * finds neither, so the terminal simply went missing from both.
 *
 * The departure terminal is the one that matters, so a line naming the origin wins;
 * otherwise the first match stands, since the departure airport is printed first.
 */
function terminalFromAirport(lines, originCode) {
  const patterns = [
    /\(\s*terminal\s*([0-9]{1,2}[A-Z]?)\s*\)?/i,
    /\bterminal\s*[:\-]?\s*([0-9]{1,2}[A-Z]?)\b/i,
    // "Bengaluru,T2" — a comma, then T and a number, with no space to separate them.
    // Requires the comma so that a word ending in "t" followed by a number cannot match.
    /,\s*T\s?([0-9]{1,2}[A-Z]?)\b/,
  ];

  const read = (text) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].toUpperCase();
    }
    return '';
  };

  const candidates = lines.filter((line) => /terminal|,\s*T\s?\d/i.test(line.text));
  if (!candidates.length) return '';

  if (originCode) {
    const atOrigin = candidates.find((line) => line.text.includes(originCode));
    if (atOrigin) {
      const found = read(atOrigin.text);
      if (found) return found;
    }
  }

  for (const line of candidates) {
    const found = read(line.text);
    if (found) return found;
  }

  // Wrapped across a line break. IndiGo sets the airport name wide enough that
  // "(Terminal 1)" splits, leaving "(Terminal" at the foot of one column and "1)" on the
  // line below — so neither line contains a readable terminal on its own.
  for (let index = 0; index < lines.length; index++) {
    const column = splitColumns(lines[index])
      .find((candidate) => /\(?\s*terminal\s*$/i.test(candidate.text.trim()));
    if (!column || !lines[index + 1]) continue;

    const beneath = splitColumns(lines[index + 1])
      .find((candidate) => Math.abs(candidate.x - column.x) < Math.max(column.width, 40));

    const match = beneath?.text.trim().match(/^([0-9]{1,2}[A-Z]?)\s*\)?/);
    if (match) return match[1].toUpperCase();
  }

  return '';
}

/**
 * Fills departure and arrival times from the printed page.
 *
 * BCBP carries no time of day at all — only the day of the year — so on a barcode-backed
 * ticket these fields would otherwise stay empty even though the itinerary prints them
 * plainly. Lines about booking, issue or check-in closing are skipped: reporting the
 * booking time as the departure would send someone to the airport at the wrong hour, and
 * do so with an air of authority.
 */
function fillPrintedTimes(draft, lines) {
  const labelled = [
    ['departureTime', [/\bdepart(?:s|ure)?(?:\s*time)?\b/i, /\bsched(?:uled)?\s*dep\w*\b/i]],
    ['arrivalTime', [/\barriv(?:es|al)?(?:\s*time)?\b/i]],
  ];

  for (const [key, patterns] of labelled) {
    const field = draft.get(key);
    if (field?.value) continue;
    const found = findLabelled(lines, patterns);
    const parsed = found ? parseTime(found.value) : null;
    if (parsed) {
      field.value = parsed.text;
      field.source = Source.PDF_TEXT;
      field.confidence = Confidence.MEDIUM;
      field.region = found.region;
    }
  }

  const departure = draft.get('departureTime');
  const arrival = draft.get('arrivalTime');
  if (departure?.value && arrival?.value) return;

  const times = [];
  for (const line of lines) {
    if (/\bbook(?:ing|ed)\b|\bissued\b|\bcloses?\b|\bprinted\b|\bbag\s*drop\b/i.test(line.text)) continue;
    for (const match of line.text.matchAll(/\b(\d{1,2}):(\d{2})\s*(?:hrs?\b)?/gi)) {
      const hour = Number(match[1]);
      if (hour <= 23) times.push(`${match[1].padStart(2, '0')}:${match[2]}`);
    }
  }

  if (!times.length) return;

  if (!departure.value) {
    departure.value = times[0];
    departure.source = Source.PDF_TEXT;
    departure.confidence = Confidence.LOW;
    departure.warn('Taken from a time printed on your ticket — please check it.', 'guessed-time');
  }
  if (!arrival.value && times.length > 1) {
    arrival.value = times[1];
    arrival.source = Source.PDF_TEXT;
    arrival.confidence = Confidence.LOW;
    arrival.warn('Taken from a time printed on your ticket — please check it.', 'guessed-time');
  }
}

/**
 * Normalises a seat number, and rejects anything that is not one.
 *
 * A seat is one to three digits then a letter — 10F, 3A, 42K. The letter I is excluded
 * because airlines skip it, being too easily read as a 1.
 *
 * Rejection matters as much as normalisation: the barcode's seat field is fixed-width
 * and, when unpopulated, arrives as characters like "0Y" that look like a seat without
 * being one. Printing that on a pass would send someone confidently to a seat that does
 * not exist.
 */
function cleanSeat(raw) {
  if (!raw) return '';

  const match = String(raw).toUpperCase().match(/\b(\d{1,3})\s?([A-HJ-KL-Z])\b/);
  if (!match) return '';

  const row = Number(match[1]);
  // Row 0 is not a seat, and no aircraft has a row beyond about 90.
  if (row < 1 || row > 99) return '';

  return `${row}${match[2]}`;
}

/**
 * Text-only fallback when there is no barcode.
 *
 * This is the ordinary case, not the exceptional one: most people keep the confirmation
 * email rather than the boarding pass, and an itinerary carries no barcode at all. So it
 * is worth reading properly rather than treating as a degraded boarding pass.
 *
 * Everything found is low confidence by construction — nothing here is authoritative —
 * but a low-confidence value the user can correct is far more use than a blank form.
 */
function buildFromTextOnly(draft, lines) {
  const text = toPlainText(lines);
  const upper = text.toUpperCase();

  const map = [
    ['passenger', 'Passenger', [/\bpassenger\s*name\b/i, /\bname\s*of\s*passenger\b/i, /\btraveller\b/i], true, false],
    ['flight', 'Flight', [/\bflight\s*(?:no\.?|number|#)\b/i, /\bflight\b/i], true, true],
    ['pnr', 'Booking ref', [/\bPNR\s*\/?\s*booking\s*reference\b/i, /\b(?:pnr|booking\s*ref\w*|record\s*locator)\b/i], true, true],
    ['seat', 'Seat', [/\bseat\b/i], false, false],
    ['gate', 'Gate', [/\bgate\b/i], false, false],
    ['terminal', 'Terminal', [/\bterminal\b/i], false, false],
    ['cabin', 'Class', [/\bfare\s*type\b/i, /\bclass\b/i], false, false],
  ];

  for (const [key, label, patterns, required, critical] of map) {
    const found = findLabelled(lines, patterns);
    let value = found?.value?.split(/\s{2,}/)[0]?.trim() || '';

    // A terminal read out of the airport's own name is still read from the page, so it
    // is recorded as printed text rather than inferred. Provenance is shown to the user
    // and has to be true.
    let fromPage = Boolean(found);

    // The same tidying the barcode path applies, so a field does not come out
    // differently depending on whether a barcode happened to be readable.
    if (key === 'terminal') {
      value = cleanTerminal(value);
      if (!value) {
        value = terminalFromAirport(lines, draft.value('origin'));
        if (value) fromPage = true;
      }
    }
    if (key === 'seat') value = cleanSeat(value) || value;

    draft.set(key, new Field({
      key,
      label,
      value,
      source: fromPage ? Source.PDF_TEXT : Source.INFERRED,
      confidence: Confidence.LOW,
      region: found?.region || null,
      required,
      critical,
    }));
  }

  // ── The route, from a printed sector ──
  //
  // Itineraries print "BLR-IXE" far more reliably than they label an origin and a
  // destination, and a labelled search for "From" on a page full of prose finds
  // something unhelpful.
  const sector = text.match(SECTOR);
  if (sector) {
    draft.set('origin', new Field({
      key: 'origin', label: 'From', value: sector[1], source: Source.PDF_TEXT,
      confidence: Confidence.MEDIUM, required: true, critical: true,
    }));
    draft.set('destination', new Field({
      key: 'destination', label: 'To', value: sector[2], source: Source.PDF_TEXT,
      confidence: Confidence.MEDIUM, required: true, critical: true,
    }));
  }

  // ── Flight number, if the label search missed it ──
  const flightField = draft.get('flight');
  if (!flightField?.value || !/\d/.test(flightField.value)) {
    const match = upper.match(FLIGHT_NUMBER);
    if (match) {
      flightField.value = `${match[1]} ${match[2]}`;
      flightField.confidence = Confidence.LOW;
      flightField.warn('Taken from a flight number printed on the page — please check it.', 'guessed-flight');
    }
  }

  // ── Date ──
  const dateFound = findLabelled(lines, [
    /\bdate\s*of\s*(?:travel|journey|departure)\b/i,
    /\btravel\s*date\b/i,
    /\bdeparture\s*date\b/i,
  ]);
  const parsedDate = dateFound ? parseDate(dateFound.value) : null;

  // Failing a labelled date, the first date on the page that is not the booking date.
  // The booking date is explicitly excluded: it is printed most prominently on many
  // itineraries and is never the date of travel.
  let fallbackDate = null;
  if (!parsedDate?.date) {
    for (const line of lines) {
      if (/\bbook(?:ing|ed)\b/i.test(line.text)) continue;
      const candidate = parseDate(line.text);
      if (candidate?.date) { fallbackDate = candidate; break; }
    }
  }

  const chosen = parsedDate?.date ? parsedDate : fallbackDate;
  draft.set('date', new Field({
    key: 'date',
    label: 'Date',
    value: chosen?.date ? chosen.date.toISOString().slice(0, 10) : '',
    source: chosen ? Source.PDF_TEXT : Source.INFERRED,
    type: 'date',
    confidence: Confidence.LOW,
    required: true,
    critical: true,
  }));

  // ── Times ──
  for (const [key, label, patterns] of [
    ['departureTime', 'Departs', [/\bdepart(?:s|ure)?\b/i, /\bdep\b/i]],
    ['arrivalTime', 'Arrives', [/\barriv(?:es|al)?\b/i, /\barr\b/i]],
  ]) {
    const found = findLabelled(lines, patterns);
    const parsed = found ? parseTime(found.value) : null;
    draft.set(key, new Field({
      key, label, value: parsed?.text || '', type: 'time',
      source: found ? Source.PDF_TEXT : Source.INFERRED,
      confidence: Confidence.LOW,
      region: found?.region || null,
    }));
  }

  // Itineraries commonly print times as "14:35 hrs, 16 Sep 2026" without a caption.
  //
  // Lines mentioning booking are skipped: "Date of booking 08 Aug 2026 07:14" is often
  // the first time on the page, and reporting it as the departure would put someone at
  // the airport seven hours early — or, worse, reassure them they had time.
  const departure = draft.get('departureTime');
  if (!departure.value) {
    const times = [];
    for (const line of lines) {
      if (/\bbook(?:ing|ed)\b|\bissued\b|\bcloses?\b|\bprinted\b/i.test(line.text)) continue;
      for (const match of line.text.matchAll(/\b(\d{1,2}):(\d{2})\s*(?:hrs?\b)?/gi)) {
        const hour = Number(match[1]);
        if (hour <= 23) times.push(`${match[1].padStart(2, '0')}:${match[2]}`);
      }
    }

    if (times.length) {
      departure.value = times[0];
      departure.warn('Taken from a time printed on the page — please check it.', 'guessed-time');
      const arrival = draft.get('arrivalTime');
      if (!arrival.value && times.length > 1) {
        arrival.value = times[1];
        arrival.warn('Taken from a time printed on the page — please check it.', 'guessed-time');
      }
    }
  }

  // ── Passenger ──
  //
  // Sought by shape as well as by label. Airlines rarely caption the traveller's name:
  // IndiGo prints the heading "Passenger Information" and then "Mr SAMPLE R" on its own
  // line, so a label search finds the heading and reports the passenger as
  // "Information". A name carries a title, or sits directly beneath that heading, and
  // both are more reliable signals here than the word "passenger".
  //
  // All names are collected, not just the first. One booking reference commonly covers a
  // family, and showing one traveller while silently dropping the rest is worse than
  // showing none — the holder has no way to know anyone is missing.
  const passengerField = draft.get('passenger');
  const names = findPassengerNames(lines);

  if (names.length && (!passengerField?.value || /\b(information|details|summary)\b/i.test(passengerField.value))) {
    passengerField.value = names[0].value;
    passengerField.region = names[0].region;
    passengerField.confidence = Confidence.LOW;
    passengerField.issues = [];
  }

  if (names.length > 1) {
    draft.passengers = names.map((name) => name.value);
    passengerField.note = `${names.length} passengers on this booking — all are listed on the back.`;
    passengerField.warn(
      `This booking covers ${names.length} passengers. Check that everyone is listed correctly.`,
      'multiple-passengers',
    );
  }

  // ── Seat description ──
  // The seat number itself is cleaned above; the parenthetical — "10F(Window)" — is a
  // description worth keeping as a note, since a traveller who chose a window seat cares.
  const seatField = draft.get('seat');
  const printedSeat = findLabelled(lines, [/\bseat\b/i]);
  const description = printedSeat?.value?.match(/\(([^)]+)\)/)?.[1];
  if (seatField?.value && description) seatField.note = description;

  // ── Provider ──
  //
  // Taken from the carrier code in the flight number where the document's own prominent
  // text is unhelpful. A full airline directory would be perpetually out of date, so
  // only the code is used — "6E" is at least true and correctable, where "Passenger
  // Information" is neither.
  const provider = findProvider(lines);
  const carrier = draft.value('flight').match(/^([A-Z0-9]{2})\b/i)?.[1];
  const operated = operatingCarrier(lines);
  const looksLikeHeading = provider?.value
    && (/\b(information|details|summary|itinerary)\b/i.test(provider.value)
      || looksLikeSalutation(provider.value));

  draft.set('provider', new Field({
    key: 'provider',
    label: 'Airline',
    value: operated?.value || (looksLikeHeading ? '' : provider?.value) || carrier || '',
    source: Source.PDF_TEXT,
    confidence: operated ? Confidence.MEDIUM : Confidence.LOW,
    region: operated?.region || (looksLikeHeading ? null : (provider?.region || null)),
  }));

  draft.warnings.push(
    'This ticket carries no barcode we could read, so every detail was taken from the '
    + 'printed text. Please check them all, and keep your original with you.'
  );

  return draft;
}

/**
 * Reads the carrier from an explicit statement of who operates the flight.
 *
 * Air India Express never prints its name as a heading — the only place the airline
 * appears at all is the line "Operated by Air India Express". Left to the prominent-text
 * search, the airline came out as "Dear SAMPLE," — the salutation, set large near the
 * top of the page. An explicit statement beats a guess about typography every time.
 */
function operatingCarrier(lines) {
  for (const line of lines) {
    const match = line.text.match(/\boperated\s+by\s+([A-Za-z][A-Za-z0-9 .'&-]{2,40})/i);
    if (!match) continue;

    const name = match[1].replace(/\s{2,}.*$/, '').replace(/[.,;]\s*$/, '').trim();
    if (name) return { value: name, region: line };
  }
  return null;
}

/** A salutation is not an airline, however prominently it is set. */
function looksLikeSalutation(value) {
  return Boolean(value) && /^(dear|hi|hello|welcome)\b/i.test(String(value).trim());
}

export default register({
  id: 'flight',
  label: 'Flight',
  detect,
  build,
});
