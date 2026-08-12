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
import { airport, isAirportCity, isKnownAirport } from '../data/airports.js';

const IATA_CODE = /^[A-Z]{3}$/;

/** An airline flight designator: two-character carrier code then one to four digits. */
/**
 * A flight number: an airline code and up to four digits.
 *
 * The hyphen is optional but significant. "AK-5233" is unambiguous; a bare "ID 7" is a
 * fragment of "identification" followed by a stray digit, and taking the first match on
 * a whole page found exactly that on an AirAsia ticket.
 *
 * `[A-Z]\d` and `\d[A-Z]` cover 6E, 9W and the like, which is why the pattern cannot
 * simply demand two letters.
 */
const FLIGHT_NUMBER = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])[\s-]?(\d{2,4})\b/;

/**
 * The same, but only where the carrier code is followed immediately by digits.
 *
 * Tried first, because a code written tight against its number — "AK-5233", "6E5306" —
 * is what a flight number looks like, and prose almost never produces it.
 */
const FLIGHT_NUMBER_TIGHT = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])-?(\d{3,4})\b/;

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

  /*
   * Two airport codes in brackets, on a page that says nothing about rail or road.
   *
   * "Kuching (KCH)" and "Kuala Lumpur (KUL)" is how a great many itineraries write a
   * route, and none of the tests above sees it: there is no hyphen so SECTOR misses, the
   * word "airport" may not appear, and the flight number sits under the logo with no
   * caption. An AirAsia e-ticket scored 35 against a threshold of 40 and was refused
   * outright — a real ticket, told it did not look like one.
   *
   * The exclusion is essential and was missing at first. An IRCTC slip writes its
   * stations exactly the same way — "MANGALURU JN (MAJN)", "YESVANTPUR JN (YPR)" — so
   * without it every Indian rail ticket scored as a flight, and 27 tests failed at once.
   * A bracketed triple is only an airport code where nothing else claims the document.
   */
  const bracketed = text.match(/\(\s*[A-Z]{3}\s*\)/g);
  const otherMode = /\bTRAIN\b|\bRAILWAY\b|\bIRCTC\b|\bPNR\s*NO\b|\bCOACH\b|\bBERTH\b|\bPLATFORM\b|\bBUS\b|\bBOARDING\s*POINT\b/.test(text);
  if (bracketed && bracketed.length >= 2 && !otherMode) score += 25;

  // Phrases that belong to an air itinerary and to no other document.
  if (/\bDEPARTURE\s*FLIGHT\b|\bRETURN\s*FLIGHT\b|\bONWARD\s*FLIGHT\b/.test(text)) score += 20;
  if (/\bSUBCLASS\b|\bFARE\s*BASIS\b|\bBAGGAGE\s*ALLOWANCE\b/.test(text)) score += 10;

  return score >= 40 ? Math.min(score, 90) : 0;
}

/**
 * Lines that carry a date which is certainly not the date of travel.
 *
 * A ticket that doubles as a tax invoice prints several dates, and the ones about the
 * *transaction* are usually nearest the top and therefore found first. A Paytm-issued
 * IndiGo ticket reads "Booked on: 08 Mar 2024" and "Invoice Date: 08 Mar 2024" above a
 * journey on 28 April, and the pass was built for the wrong day by seven weeks.
 *
 * Defined once and shared, because this was previously written three times in three
 * slightly different forms — one knew about invoices and two did not.
 */
const NOT_A_TRAVEL_DATE = /\b(?:book(?:ing|ed)|issued?|printed?|purchased?|generated|invoice|receipt|billed?|paid|transaction|order(?:ed)?|created)\b/i;

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

  /*
   * An unknown code is our gap, not the ticket's fault.
   *
   * The reference table is deliberately small — a complete airport database is megabytes,
   * and this loads in a browser at a gate — so codes will be missing, and IXE was:
   * Mangaluru, a real airport, read correctly from the barcode. Flagging it as a problem
   * with the ticket asked the user to check something that was already right, and did it
   * in the warning colour used for genuine faults.
   *
   * A code from the barcode is the airline's own record of where this flight goes. All we
   * can honestly say is that we have nothing to add.
   */
  if (from) origin.note = from.city ? `${from.city}${from.name ? ` — ${from.name}` : ''}` : from.name;
  else if (origin.source !== Source.BARCODE) origin.warn('This airport code is not one we recognise.', 'unknown-airport');
  else origin.note = 'We do not hold a name for this airport.';

  if (to) destination.note = to.city ? `${to.city}${to.name ? ` — ${to.name}` : ''}` : to.name;
  else if (destination.source !== Source.BARCODE) destination.warn('This airport code is not one we recognise.', 'unknown-airport');
  else destination.note = 'We do not hold a name for this airport.';

  // The PDF usually prints the codes too; agreement confirms we read the right record.
  const printed = toPlainText(lines).toUpperCase();
  if (printed.includes(leg.from)) origin.corroborate(Source.PDF_TEXT);
  if (printed.includes(leg.to)) destination.corroborate(Source.PDF_TEXT);

  return { from, to };
}

function buildTimeFields(draft, leg, lines, airports) {
  // The travel date, and nothing else that happens to be called a date.
  //
  // A bare "date" pattern matched "*Date of booking 08 Aug 2026" on an IndiGo itinerary,
  // which then disagreed with the barcode — and the app offered the booking date as the
  // correction, inviting the user to move their flight a month earlier.
  //
  // Lines announcing a booking, issue or print are removed before the search rather than
  // excluded by lookbehind, which older Safari does not support.
  const travelLines = lines.filter((line) => !NOT_A_TRAVEL_DATE.test(line.text));

  const printedDate = findLabelled(travelLines, [
    /\b(?:date\s*of\s*(?:travel|journey|departure)|travel\s*date|flight\s*date|departure\s*date)\b/i,
    /\bdate\b/i,
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
  // The check-in sequence number is deliberately not surfaced. It records that you were
  // the nth person to check in, which is of no use to a traveller and reads as noise
  // beside the fields that matter — particularly when it decodes as "0".
  if (leg.frequentFlyerNumber) {
    draft.set('frequentFlyer', new Field({
      key: 'frequentFlyer', label: 'Frequent flyer', value: leg.frequentFlyerNumber, source: Source.BARCODE,
    }));
  }

  // ── Provider ──
  //
  // Taken from the document's own prominent text, but section headings are rejected:
  // "Passenger Information" is set large and near the top of an IndiGo itinerary, and
  // would otherwise be reported as the airline.
  //
  // A bare carrier code found in the text is expanded rather than used as-is. IndiGo
  // prints "6E" as its most prominent text, so the search finds a true value that nobody
  // would recognise as an airline name.
  const provider = findProvider(lines);
  const operated = operatingCarrier(lines);

  /*
   * A document title is not a brand. See `looksLikeDocumentTitle`.
   */
  const looksLikeHeading = looksLikeDocumentTitle(provider?.value);

  const fromText = looksLikeHeading ? '' : expandCarrierCode(provider?.value);

  const providerValue = operated?.value || fromText || airlineName(leg.carrier);

  const providerField = draft.set('provider', new Field({
    key: 'provider',
    label: 'Airline',
    value: providerValue || leg.carrier,
    source: providerValue ? Source.PDF_TEXT : Source.BARCODE,
    confidence: operated ? Confidence.MEDIUM
      : (providerValue ? provider?.confidence || Confidence.MEDIUM : Confidence.MEDIUM),
    region: operated?.region || (looksLikeHeading ? null : (provider?.region || null)),
  }));

  // The code is what appears on departure boards, so it is kept alongside the name.
  if (leg.carrier && providerField.value && providerField.value !== leg.carrier) {
    providerField.note = leg.carrier.toUpperCase();
  }

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
/**
 * Words that mark a line as a caption rather than a value.
 *
 * A line naming any field is furniture, wherever the word sits in it. Kept as a single
 * list because a name is the one field with no reliable label — it is found by shape, so
 * everything that is *not* a name has to be excluded by hand.
 */
const CAPTION_WORD = /\b(?:sector|seat|add-?ons?|status|information|details?|baggage|fare|origin|destination|departure|arrival|terminal|gate|class|cabin|flight|passenger|pax|booking|reference|ticket|from|to|date|time|type|gender|age|name)\b/i;

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

  /**
   * Adds a name, unless we already have it.
   *
   * Containment, not equality. OCR reads the same passenger twice on a ticket that
   * prints the name in two places — once in a summary and once beside a barcode — and
   * picks up a stray word from the neighbouring column on one of them. "MD SHAUKAT ALAM"
   * and "MD SHAUKAT ALAM Deana" then both survived an exact-match check, and a booking
   * for four came out as a booking for six.
   *
   * The shorter reading wins. A name that is a prefix of another is the clean one; the
   * extra word came from somewhere else on the page.
   */
  const add = (value, region) => {
    if (!value) return;
    if (value.length < 2 || value.length > 40) return;

    /*
     * A city is not a passenger.
     *
     * "Bengaluru" appeared in a list of travellers on a Paytm-issued IndiGo ticket,
     * sitting between two real names. It came from the airport line — "Bengaluru,
     * Kempegowda Airport" — which is a short capitalised phrase with no digits, exactly
     * the shape a name-finder is looking for.
     *
     * The airport table already knows every city this app can name, so the check costs
     * nothing and is not a word list that will rot. A single word matching a city is
     * refused; two or more words are left alone, because a surname can coincide with a
     * place and "Mr Ahmedabad Sharma" is a person.
     */
    if (!/\s/.test(value) && isAirportCity(value)) return;

    const key = value.toUpperCase();
    if (seen.has(key)) return;

    for (const existing of found) {
      const other = existing.value.toUpperCase();
      if (other === key) return;

      // One is the beginning of the other, on a word boundary.
      if (key.startsWith(`${other} `)) return;
      if (other.startsWith(`${key} `)) {
        existing.value = value;
        existing.region = region;
        seen.add(key);
        return;
      }
    }

    seen.add(key);
    found.push({ value, region });
  };

  /*
   * Searched one column at a time, never across a whole line.
   *
   * A line's `text` has had its column gaps collapsed to single spaces, so by the time
   * it is a string there is nothing left to tell "Ganesan Natesan" in the name column
   * from "NTM54A" in the PNR column beside it. The title pattern reads up to three more
   * capitalised words after the honorific and duly walked straight into the next column.
   *
   * On an ixigo itinerary this produced passengers called "Ganesan Natesan NTM" — the
   * PNR, clipped at the first digit because digits are not in the name character class,
   * so it did not even look obviously wrong. The same row in the add-ons table gave
   * "Ganesan Natesan MAA-HYD", the sector welded on, hyphens being legitimate in a
   * surname. A booking for two came out as a booking for four, and the two extra were
   * the same two people wearing a PNR and a route.
   *
   * The column geometry is still intact on the line's items, and `splitColumns` is what
   * reads it. Matching inside a cell means the pattern cannot reach past the gap however
   * many capitalised words follow it.
   */
  for (const line of lines) {
    for (const column of splitColumns(line)) {
      for (const match of column.text.matchAll(TITLE)) {
        add(strip(match[1]), line);
      }
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
      if (value.split(/\s+/).length > 5) continue;

      // Nor is a passenger *type* a passenger. "Adult" sits in its own column beside the
      // name and again in the baggage table, and reads as a person to anything looking
      // for a short capitalised word.
      if (/^(?:adults?|child(?:ren)?|infants?|senior|youth)$/i.test(value)) continue;

      // Any caption word disqualifies the whole line, wherever it sits. Testing only for
      // a few words allowed "ORIGIN BLR" through as a passenger, because neither word
      // was on the list — and a line that names a field is a header no matter what else
      // it carries.
      if (CAPTION_WORD.test(value)) continue;

      add(value, lines[next]);
    }

    if (found.length) break;
  }

  return found;
}

/**
 * The dates printed on a line, as YYYY-MM-DD.
 *
 * Used to tell a journey's own times from a booking or print stamp. Deliberately more
 * permissive than `parseDate`: that refuses an ambiguous all-numeric date because
 * guessing wrong would put someone at the airport on the wrong day. Here the question is
 * only *"does this line belong to the journey?"*, so both readings of an ambiguous date
 * are returned and a match on either is enough — a wrong guess about day-versus-month
 * cannot mislead anyone.
 */
function datesOnLine(text) {
  const found = [];

  // 16 Sep 2026 / 16-SEP-26 — unambiguous, because the month is named.
  const named = text.match(/\b(\d{1,2})[\s-]*([A-Za-z]{3,9})[\s-]*(\d{2,4})\b/);
  if (named) {
    const month = MONTH_INDEX[named[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const year = named[3].length === 2 ? 2000 + Number(named[3]) : Number(named[3]);
      found.push(iso(year, month + 1, Number(named[1])));
    }
  }

  // 08/08/2026 — could be day-first or month-first, so both are kept.
  const numeric = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (numeric) {
    const [, a, b, year] = numeric;
    found.push(iso(Number(year), Number(b), Number(a)));
    found.push(iso(Number(year), Number(a), Number(b)));
  }

  const isoForm = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoForm) found.push(`${isoForm[1]}-${isoForm[2]}-${isoForm[3]}`);

  return found.filter(Boolean);
}

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function iso(year, month, day) {
  if (!year || !month || !day || month > 12 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Airline names for the carrier codes people actually meet.
 *
 * Deliberately short. A complete directory of every IATA code would be perpetually out
 * of date and is not worth carrying in an app that must work offline; this covers the
 * carriers a traveller is likely to hold a ticket for, and anything unknown falls back
 * to the code itself — "6E" is at least true, where a wrong airline name is not.
 *
 * The code stays visible as a note, since that is what appears on the departure boards.
 */
const AIRLINE_NAMES = {
  // India
  '6E': 'IndiGo',
  AI: 'Air India',
  IX: 'Air India Express',
  UK: 'Vistara',
  SG: 'SpiceJet',
  QP: 'Akasa Air',
  G8: 'Go First',
  I5: 'AIX Connect',
  // Gulf and wider Asia
  EK: 'Emirates',
  EY: 'Etihad',
  QR: 'Qatar Airways',
  SQ: 'Singapore Airlines',
  MH: 'Malaysia Airlines',
  TG: 'Thai Airways',
  CX: 'Cathay Pacific',
  NH: 'ANA',
  JL: 'Japan Airlines',
  KE: 'Korean Air',
  AK: 'AirAsia',
  FD: 'Thai AirAsia',
  UL: 'SriLankan Airlines',
  BG: 'Biman Bangladesh',
  PK: 'Pakistan International',
  // Europe
  BA: 'British Airways',
  LH: 'Lufthansa',
  AF: 'Air France',
  KL: 'KLM',
  IB: 'Iberia',
  AZ: 'ITA Airways',
  LX: 'SWISS',
  OS: 'Austrian Airlines',
  SK: 'SAS',
  AY: 'Finnair',
  TK: 'Turkish Airlines',
  FR: 'Ryanair',
  U2: 'easyJet',
  W6: 'Wizz Air',
  VS: 'Virgin Atlantic',
  // Americas and Oceania
  AA: 'American Airlines',
  DL: 'Delta',
  UA: 'United',
  WN: 'Southwest',
  AC: 'Air Canada',
  B6: 'JetBlue',
  AS: 'Alaska Airlines',
  QF: 'Qantas',
  NZ: 'Air New Zealand',
  // Africa
  ET: 'Ethiopian Airlines',
  MS: 'EgyptAir',
  SA: 'South African Airways',
  KQ: 'Kenya Airways',
};

/** The airline's name for a carrier code, or the code itself when unknown. */
function airlineName(code) {
  if (!code) return '';
  return AIRLINE_NAMES[code.toUpperCase()] || code.toUpperCase();
}

/**
 * Expands a value that is only a carrier code, or a flight number.
 *
 * IndiGo sets "6E 5306" as the most prominent text on its itinerary, so the provider
 * search returns something true but useless — nobody calls their airline "6E 5306".
 * Anything else is left exactly as printed: the airline's own wording for its name is
 * always better than ours.
 */
function expandCarrierCode(value) {
  const text = String(value || '').trim();

  // A bare code: "6E".
  if (/^[A-Z0-9]{2}$/i.test(text)) return airlineName(text);

  // A flight number: "6E 5306", "AI-2814".
  const flight = text.match(/^([A-Z0-9]{2})[\s-]?\d{1,4}[A-Z]?$/i);
  if (flight) {
    const named = airlineName(flight[1]);
    // Only when the code is one we recognise — otherwise "XY 123" would become "XY",
    // which is less informative than what was printed.
    return named !== flight[1].toUpperCase() ? named : text;
  }

  return text;
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

  // Times printed without a caption, ranked by the date they sit beside.
  //
  // This used to be a blocklist of words — booking, issued, printed — which fails the
  // moment an airline phrases it differently. One IndiGo itinerary stamps "*Date of
  // booking 08 Aug 2026 07:14" and was correctly skipped; a newer download of the same
  // ticket prints a bare "08/08/2026 14:04", matched no keyword, and became the first
  // time on the page. Departure was then reported as 14:04 and arrival as 14:35 — the
  // real departure — with every time shifted by one. Someone would have arrived half an
  // hour late for a flight the app told them, with an air of authority, they had time
  // for.
  //
  // The reliable signal is the date beside the time. A ticket knows when the journey is;
  // a time printed against any other date belongs to something else — when it was
  // booked, issued, or printed. That holds however the label is worded, and in whatever
  // language.
  const journeyDate = draft.value('date');

  const onJourneyDate = [];
  const undated = [];

  for (const line of lines) {
    // Kept as a second line of defence, for pages that print a stamp with no date at all.
    if (/\bbook(?:ing|ed)\b|\bissued\b|\bgenerated\b|\bcloses?\b|\bprinted\b|\bbag\s*drop\b/i.test(line.text)) continue;

    const lineDates = datesOnLine(line.text);

    // A date that is not the journey's: everything on this line is about some other
    // moment entirely.
    if (lineDates.length && journeyDate && !lineDates.includes(journeyDate)) continue;

    const bucket = journeyDate && lineDates.includes(journeyDate) ? onJourneyDate : undated;

    for (const match of line.text.matchAll(/\b(\d{1,2}):(\d{2})\s*(?:hrs?\b)?/gi)) {
      const hour = Number(match[1]);
      if (hour <= 23) bucket.push(`${match[1].padStart(2, '0')}:${match[2]}`);
    }
  }

  // Times printed against the travel date are the journey's own; anything else is a
  // guess, used only when the ticket gives us nothing better.
  const times = onJourneyDate.length ? onJourneyDate : undated;

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
/**
 * The IATA code inside a value, however it was written.
 *
 * Tickets state a place in at least four ways, and an app that only understands one of
 * them is an app tuned to whoever printed the ticket it was tested against:
 *
 *   BLR
 *   Bengaluru (BLR)
 *   BLR - Bengaluru
 *   Kempegowda International Airport, Bengaluru (BLR)
 *
 * A parenthesised three-letter code is taken first, since brackets are unambiguous.
 * Otherwise the first standalone triple of capitals. Anything else — a city name with no
 * code at all — returns nothing rather than a guess, because a wrong airport is worse
 * than a blank one the user is asked to fill.
 */
function airportCode(raw) {
  if (!raw) return '';

  const value = String(raw).trim();

  const bracketed = value.match(/\(\s*([A-Z]{3})\s*\)/);
  if (bracketed) return bracketed[1];

  // Standalone: bounded by a start, end, or non-letter on both sides, so "DELHI" does
  // not yield "DEL" and "TERMINAL" does not yield "TER".
  const standalone = value.toUpperCase().match(/(?:^|[^A-Z])([A-Z]{3})(?:[^A-Z]|$)/);
  return standalone ? standalone[1] : '';
}

/**
 * Whether the most prominent text on a page is the document's own title.
 *
 * `findProvider` takes the largest, boldest text as the operator's name, which works
 * because a ticket leads with its brand — except when it leads with what it *is*. An
 * AirAsia itinerary sets "E-Ticket" across the top and reported that as the airline,
 * while the word "AirAsia" sat directly beneath the logo.
 *
 * Shared by both build paths. It existed twice, in two slightly different versions, so
 * the barcode path knew about "booking" and "reference" and the text-only path did not —
 * and a fix applied to one silently missed the other.
 */
function looksLikeDocumentTitle(value) {
  if (!value) return false;

  /*
   * Noise is not a brand either.
   *
   * `findProvider` takes the most prominent text, which on a photographed ticket is
   * whatever OCR made of the logo — "Zi", "74] PNR: NKSFFI", "amazon pa Powered by
   * mates (erp". An airline's name is a word or two of letters; anything carrying
   * punctuation, digits or a stray bracket came from the image, not from a brand.
   */
  const noisy = /[[\]{}|\\/@#*_~`]/.test(value)
    || /\d/.test(value)
    || value.split(/\s+/).length > 4
    || value.replace(/[^A-Za-z]/g, '').length < 3;
  if (noisy) return true;

  return /\b(information|details|summary|itinerary|booking|reference)\b/i.test(value)
    || /^\s*e-?\s*(?:ticket|boarding|receipt)\b/i.test(value)
    || /\b(?:boarding\s*pass|e-?ticket|itinerary\s*receipt|travel\s*document|reservation\s*slip|electronic\s*ticket|departure\s*flight|flight\s*booking)\b/i.test(value)
    || looksLikeSalutation(value);
}

function buildFromTextOnly(draft, lines) {
  const text = toPlainText(lines);
  const upper = text.toUpperCase();

  const map = [
    // "Pax" is trade shorthand for a passenger and appears on tickets worldwide — bus,
    // rail and air alike. Knowing the word is not vendor tuning; it is vocabulary, the
    // same as knowing "PNR". The same goes for "Dep" and "Arr".
    ['passenger', 'Passenger', [
      /\bpassenger\s*(?:name|details?)\b/i,
      /\bpax\s*(?:name|details?)?\b/i,
      /\bname\s*of\s*(?:the\s*)?passenger\b/i,
      /\btraveller?\s*(?:name)?\b/i,
      /\bguest\s*name\b/i,
      // Bare "Passenger" last, and never where it introduces something else about the
      // passenger rather than the passenger — "Passenger Mobile No" put a phone number
      // on a pass as a person's name.
      /\bpassenger\b(?!\s*(?:mobile|phone|contact|email|e-?mail|address|count|type|no\b|nos\b|number))/i,
    ], true, false],
    ['flight', 'Flight', [/\bflight\s*(?:no\.?|number|#)\b/i, /\bflight\b/i], true, true],
    ['pnr', 'Booking ref', [
      /\bPNR\s*\/?\s*booking\s*reference\b/i,
      /\b(?:pnr|booking\s*ref\w*|record\s*locator)\b/i,
      /\bconfirmation\s*(?:no\.?|number|code)\b/i,
      /\breservation\s*(?:no\.?|number|code)\b/i,
    ], true, true],
    ['seat', 'Seat', [/\bseat\b/i], false, false],
    ['gate', 'Gate', [/\bgate\b/i], false, false],
    ['terminal', 'Terminal', [/\bterminal\b/i], false, false],
    ['cabin', 'Class', [
      /\bfare\s*type\b/i,
      /\bcabin\b/i,
      /\bclass\s*of\s*travel\b/i,
      // "Subclass" as well as "Class". An AirAsia ticket prints "Subclass Z ( Economy )"
      // and nothing else about the cabin, so a pattern anchored on the word alone read
      // no class at all.
      /\bsub-?class\b/i,
      /\bclass\b/i,
    ], false, false],
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

    /*
     * A cabin is a class of travel, not a weight.
     *
     * "Cabin" heads the hand-baggage column of a baggage table — "Traveller | Cabin |
     * Check-in" — so the class came out as "7 Kgs (1 piece only)" on every MakeMyTrip
     * itinerary. The word is genuinely used both ways on the same page, so the label
     * cannot settle it; the value can.
     *
     * A class is a short word or a fare code: Economy, Business, First, Premium, Saver,
     * or a single letter. It never carries a weight, a count or a piece.
     */
    if (key === 'cabin' && value) {
      const plausible = value.length <= 24
        && !/\b(?:kgs?|kilograms?|pieces?|piece|lbs?)\b/i.test(value)
        && !/^\d/.test(value);
      if (!plausible) { value = ''; fromPage = false; }
    }

    /*
     * A passenger type is not a passenger.
     *
     * "Adult", "Child" and "Infant" head their own column beside a traveller's name, and
     * appear again in the baggage table where there is no name at all. A pass reading
     * "Adult" where a person should be is worse than a blank: it looks filled in.
     */
    if (key === 'passenger' && /^(?:adults?|child(?:ren)?|infants?|senior|youth)$/i.test(value.trim())) {
      value = '';
      fromPage = false;
    }

    /*
     * A name ends where the next caption begins.
     *
     * Where two labelled pairs share a printed line — "Passenger(s): SHASTRY/RAVISHANKARA
     * C     Airline Reservation Code: AKSSPZ (EY)" on a Sabre itinerary — the value taken
     * for the first label runs on into the second, and the pass showed a passenger called
     * "SHASTRY/RAVISHANKARA C Airline Reservation Code: AKSSPZ (EY)".
     *
     * Cutting at the next caption is safe here in a way it would not be for a free-text
     * field: a person's name never contains a labelling colon. Applied before the digit
     * check below, which would otherwise discard the whole thing on the strength of a
     * digit belonging to the neighbouring column.
     */
    if (key === 'passenger' && value) {
      /*
       * Each word of the caption must be a word, not an initial.
       *
       * A looser pattern cut at the space before "C Airline Reservation Code:" and
       * reported the passenger as "SHASTRY/RAVISHANKARA", losing the middle initial that
       * appears on the passport. Requiring three letters a word, and at least two words,
       * means a caption is recognised as a caption while an initial stays with the name.
       */
      const nextCaption = value.search(/\s(?:[A-Za-z][A-Za-z()#/.]{2,}\s+){0,3}[A-Za-z][A-Za-z()#/.]{2,}:/);
      if (nextCaption > 0) value = value.slice(0, nextCaption).trim();
    }

    // A name is not a number. Whatever the label said, a value containing a digit is
    // something else about the passenger — a mobile, a count, an age — and never the
    // person.
    if (key === 'passenger' && /\d/.test(value)) { value = ''; fromPage = false; }

    /*
     * A booking reference has a shape, and neither a fragment of its own label nor an
     * airport's name is it.
     *
     * "PNR No." cannot be matched to its end — there is no word boundary between a full
     * stop and a space — so the pattern stops at "PNR", leaving " No." as the remainder,
     * and an agency-issued IndiGo ticket reported its reference as the word "No.".
     *
     * And a ticket that prints "PNR" above an airport line gave "Lal Bahadur Shastri
     * International" as the booking reference. Every reference in use is one token of
     * four to ten characters, letters and digits with no spaces. Nothing with a space in
     * it has ever been a PNR.
     */
    if (key === 'pnr' && value) {
      const plausible = /^[A-Z0-9][A-Z0-9-]{3,15}$/i.test(value)
        && !/^[A-Za-z]{1,3}\.?$/.test(value);
      if (!plausible) { value = ''; fromPage = false; }
    }

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

  // ── The route ──
  //
  // Two ways, in order of reliability.
  //
  // A printed sector — "BLR-DEL" — is the stronger signal: itineraries carry it far more
  // reliably than they label an origin and a destination, and it cannot be confused with
  // prose.
  //
  // Failing that, labelled fields. This path had *none*, so a ticket that plainly said
  // "From: BLR   To: DEL" produced no route at all unless a barcode supplied one. Every
  // image and every text-only PDF lost its route, which is the single most important
  // thing on a boarding pass.
  const sector = text.match(SECTOR);
  let from = sector?.[1] || '';
  let to = sector?.[2] || '';
  let routeRegion = null;

  if (!from || !to) {
    // "Origin" and "Destination" before the bare "From" and "To", which are common words
    // — "from" appears in every line of small print on a ticket.
    const originFound = findLabelled(lines, [
      /\borigin(?:\s*(?:airport|city|station))?\b/i,
      /\bdeparture\s*(?:airport|city|station)\b/i,
      /\bfrom\b/i,
    ]);
    const destinationFound = findLabelled(lines, [
      /\bdestination(?:\s*(?:airport|city|station))?\b/i,
      /\barrival\s*(?:airport|city|station)\b/i,
      /\bto\b/i,
    ]);

    from = from || airportCode(originFound?.value);
    to = to || airportCode(destinationFound?.value);
    routeRegion = originFound?.region || null;
  }

  /*
   * Failing both: two known airport codes on one line.
   *
   * A Paytm-issued IndiGo ticket lays its route across a row with no captions at all —
   * "DPS  11:30      15:30  BLR" — so there is no sector to match and no label to find,
   * and the pass came out with no route whatsoever. That is the one thing a boarding
   * pass must carry.
   *
   * Only codes the airport table recognises count, and only a line holding exactly two
   * of them. That is what keeps it from reading three-letter words: a line of prose
   * rarely contains two real IATA codes and nothing else, and one that does is a route.
   * Order is reading order, which is departure then arrival on every ticket in any
   * language.
   */
  if (!from || !to) {
    for (const line of lines) {
      const codes = (line.text.toUpperCase().match(/\b[A-Z]{3}\b/g) || [])
        .filter((code) => isKnownAirport(code));

      // Exactly two, and not the same airport twice.
      const unique = [...new Set(codes)];
      if (unique.length !== 2) continue;

      from = from || unique[0];
      to = to || unique[1];
      routeRegion = routeRegion || line;
      break;
    }
  }

  if (from && to) {
    draft.set('origin', new Field({
      key: 'origin', label: 'From', value: from, source: Source.PDF_TEXT,
      confidence: sector ? Confidence.MEDIUM : Confidence.LOW,
      region: sector ? null : routeRegion, required: true, critical: true,
    }));
    draft.set('destination', new Field({
      key: 'destination', label: 'To', value: to, source: Source.PDF_TEXT,
      confidence: sector ? Confidence.MEDIUM : Confidence.LOW,
      required: true, critical: true,
    }));
  }

  // ── Flight number, if the label search missed it ──
  //
  // The tight form first — a carrier code hard against three or four digits, which is
  // what a flight number looks like and what prose almost never produces. Falling
  // straight to the loose pattern took the first plausible pair anywhere on the page,
  // and on an AirAsia ticket that was "ID 7", carved out of "identification".
  const flightField = draft.get('flight');
  if (!flightField?.value || !/\d/.test(flightField.value)) {
    const match = upper.match(FLIGHT_NUMBER_TIGHT) || upper.match(FLIGHT_NUMBER);
    if (match) {
      flightField.value = `${match[1]} ${match[2]}`;
      flightField.confidence = Confidence.LOW;
      flightField.warn('Taken from a flight number printed on the page — please check it.', 'guessed-flight');
    }
  }

  // ── Date ──
  //
  // A labelled travel date is preferred, but the label must say *travel*: an invoice
  // date is labelled too, and matching "date" alone found it first.
  const dateFound = findLabelled(lines, [
    /\bdate\s*of\s*(?:travel|journey|departure)\b/i,
    /\btravel\s*date\b/i,
    /\bdeparture\s*date\b/i,
  ]);
  const parsedDate = dateFound ? parseDate(dateFound.value) : null;

  // Failing that, the first date on the page that is not about the transaction. Booking,
  // invoice and issue dates are printed most prominently on many itineraries and are
  // never the date of travel.
  let fallbackDate = null;
  if (!parsedDate?.date) {
    for (const line of lines) {
      if (NOT_A_TRAVEL_DATE.test(line.text)) continue;
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
  // Shared with the barcode path so a ticket does not read differently depending on
  // whether its barcode happened to be legible.
  fillPrintedTimes(draft, lines);

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

  /*
   * A name found by shape beats one found by label.
   *
   * This used to defer to the label search unless it had returned nothing or an obvious
   * heading. That held only while the label search was poor: once it learned to look in
   * the column beside a caption, it started returning the *header* of a passenger table
   * — "Name", "Sector" — which passed the heading test and blocked the real name.
   *
   * A title is close to conclusive. "Mr SAMPLE R" is a person; a cell reading "Name" is
   * furniture. So a shaped name wins outright, and the label result is kept only when
   * nothing was found by shape at all.
   */
  if (names.length) {
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
  // The carrier code from the flight number is the most reliable signal, since the
  // document's own prominent text is often a section heading. A short lookup turns "6E"
  // into "IndiGo" — the code is true but nobody calls their airline that, and a pass
  // showing two letters looks unfinished.
  const provider = findProvider(lines);
  const carrier = draft.value('flight').match(/^([A-Z0-9]{2})\b/i)?.[1];
  const operated = operatingCarrier(lines);
  const looksLikeHeading = looksLikeDocumentTitle(provider?.value);

  const named = airlineName(carrier);
  const value = operated?.value || (looksLikeHeading ? '' : provider?.value) || named || '';

  const providerField = draft.set('provider', new Field({
    key: 'provider',
    label: 'Airline',
    value,
    source: Source.PDF_TEXT,
    // A name from the lookup is as certain as the flight number it came from.
    confidence: (operated || (named && named !== carrier)) ? Confidence.MEDIUM : Confidence.LOW,
    region: operated?.region || (looksLikeHeading ? null : (provider?.region || null)),
  }));

  // The code is what appears on departure boards, so it is kept alongside the name.
  if (carrier && value && value !== carrier) providerField.note = carrier.toUpperCase();

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
