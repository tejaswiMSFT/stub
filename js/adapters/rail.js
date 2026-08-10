/**
 * Ground transport adapter — trains and buses.
 *
 * Rail and road tickets are handled together because, to Wallet, they are the same
 * object: a boardingPass with an origin, a destination and a transitType. Only the
 * vocabulary differs — "coach and berth" versus "seat", "train no" versus "service".
 * Splitting them into two adapters would duplicate the entire field-mapping layer to
 * express that difference, so instead the mode is detected once and drives a small
 * dictionary.
 *
 * Unlike flights, there is no BCBP here. No Indian rail or road operator encodes a
 * structured, parseable record in its barcode: IRCTC prints a PNR-bearing QR whose
 * payload varies by channel, and most state road transport corporations print either a
 * bare booking reference or nothing at all. Every value therefore comes from text and
 * is treated as a suggestion, not a fact.
 *
 * This adapter must never refuse a ticket. State transport undertakings do not issue
 * .pkpass files and never will, which is precisely why someone would reach for this
 * tool — so an unrecognised bus ticket produces a sparse pass for the user to correct,
 * never an error.
 */

import {
  register, Field, Source, Confidence, TicketDraft,
  parseTime, parseDate, findLabelled, findProvider, toPlainText,
} from './registry.js';
import { readTable } from '../text.js';
import { parseSeats } from './event.js';

// ────────────────────────────── mode detection ──────────────────────────────

export const Mode = {
  RAIL: 'rail',
  BUS: 'bus',
};

/**
 * Operators worth naming explicitly.
 *
 * This is not an attempt at a complete registry — that would rot immediately. These
 * are here because they are strong *mode* signals: "KSRTC" on a document settles that
 * it is a bus ticket far more reliably than any layout heuristic could. The provider
 * name itself still comes from the document's own text.
 */
const BUS_OPERATORS = [
  // State road transport undertakings.
  /\bK[SA]RTC\b/i, /\bKSRTC\b/i, /\bBMTC\b/i, /\bAPSRTC\b/i, /\bTSRTC\b/i,
  /\bTGSRTC\b/i, /\bMSRTC\b/i, /\bTNSTC\b/i, /\bSETC\b/i, /\bUPSRTC\b/i,
  /\bRSRTC\b/i, /\bGSRTC\b/i, /\bHRTC\b/i, /\bPEPSU\b/i, /\bPRTC\b/i,
  /\bWBTC\b/i, /\bSBSTC\b/i, /\bOSRTC\b/i, /\bBSRTC\b/i, /\bJKSRTC\b/i,
  /\bCSTC\b/i, /\bNEKRTC\b/i, /\bKKRTC\b/i,
  // Long-distance private operators and aggregators.
  /\bredbus\b/i, /\babhibus\b/i, /\bpaytm\s*bus\b/i, /\bVRL\s*travels?\b/i, /\bSRS\s*travels\b/i,
  /\bkallada\b/i, /\bparveen\s*travels\b/i, /\borange\s*travels\b/i, /\bneeta\s*travels\b/i,
  /\bsharma\s*transports\b/i, /\bzingbus\b/i, /\bintrcity\b/i,
  // Service brands.
  /\bairavat\b/i, /\brajahamsa\b/i, /\bambaari\b/i,
  /\bshivneri\b/i, /\bsheetal\b/i, /\bgaruda\s*(?:plus|class)?\b/i, /\bvennela\b/i,
  /\bvajra\b/i, /\bvayu\s*vajra\b/i, /\bsuvarna\b/i, /\bkarnataka\s*sarige\b/i,

  // Deliberately absent, and they must stay absent:
  //
  //   UTC   — Uttarakhand Transport Corporation, but overwhelmingly the timezone. Every
  //           airline itinerary carries "UTC (Coordinated Universal Time)", which was
  //           enough to score a flight as a bus and route it to the wrong adapter.
  //   BEST  — Mumbai's undertaking, but also an ordinary English word appearing on
  //           almost any document.
  //   VOLVO — a vehicle make, printed on coach tickets but also on much else.
  //
  // An operator name that is also a common word cannot be a detection signal. The cost
  // of a false match is not a slightly worse guess; it is the entire ticket handed to an
  // adapter that cannot read it.
];

const RAIL_OPERATORS = [
  /\bIRCTC\b/i, /\bindian\s*rail(?:way)?s?\b/i, /\bnorthern\s*railway\b/i,
  /\bkonkan\s*railway\b/i, /\bvande\s*bharat\b/i, /\brajdhani\b/i, /\bshatabdi\b/i,
  /\bduronto\b/i, /\bgaribrath\b/i, /\btejas\b/i, /\bhumsafar\b/i, /\bnamo\s*bharat\b/i,
  /\bmetro\s*rail\b/i, /\bDMRC\b/i, /\bBMRCL\b/i, /\bnamma\s*metro\b/i,
  /\beurostar\b/i, /\btrenitalia\b/i, /\brenfe\b/i, /\bSNCF\b/i, /\bamtrak\b/i,
  /\bdeutsche\s*bahn\b/i, /\bnational\s*rail\b/i, /\bthameslink\b/i,
];

/** Indian reserved-class codes. Their presence is close to proof of a rail ticket. */
const RAIL_CLASSES = /\b(?:1A|2A|3A|3E|2S|SL|CC|EC|EA|FC)\b/;

/** Berth positions — rail-only vocabulary; buses have seats and bunks, never berths. */
const BERTH_CODES = /\b(?:LB|MB|UB|SL|SU|SLB|SUB|WS)\b/;

const RETIRING_ROOM = /\bretiring\s*room|\bdormitor(?:y|ies)\b|\bwaiting\s*room\s*booking\b|\bcheck[-\s]?in\b.*\bcheck[-\s]?out\b/i;

/**
 * Scores how strongly a document looks like a train or bus ticket, and which.
 *
 * Returned as a single object so `detect` and `build` agree on the mode without
 * running the same regexes twice.
 */
export function classify(context) {
  const text = toPlainText(context.lines || []);
  const upper = text.toUpperCase();

  let rail = 0;
  let bus = 0;

  // ── Operator names: the single strongest mode signal ──
  const railOperator = RAIL_OPERATORS.find((pattern) => pattern.test(text));
  const busOperator = BUS_OPERATORS.find((pattern) => pattern.test(text));
  if (railOperator) rail += 45;
  if (busOperator) bus += 45;

  // ── Rail-specific vocabulary ──
  if (/\bTRAIN\s*(?:NO|NUMBER|#|NAME)\b/.test(upper)) rail += 35;
  if (/\bCOACH\b/.test(upper)) rail += 25;
  if (/\bBERTH\b/.test(upper)) rail += 25;
  if (/\bPLATFORM\b/.test(upper)) rail += 10;
  if (/\bCHART\s*(?:IS\s*)?(?:PREPARED|NOT\s*PREPARED)\b/.test(upper)) rail += 30;
  if (/\bQUOTA\b/.test(upper)) rail += 15;
  if (/\bRAC\b|\bWAITLIST(?:ED)?\b|\bWL\b|\bCNF\b/.test(upper)) rail += 20;
  if (/\bE[-\s]?TICKET\b/.test(upper) && /\bPNR\b/.test(upper)) rail += 10;
  if (RAIL_CLASSES.test(upper) && /\bCLASS\b/.test(upper)) rail += 15;
  if (/\bTRAIN\b/.test(upper)) rail += 10;

  // ── Bus-specific vocabulary ──
  if (/\bBUS\b/.test(upper)) bus += 25;
  if (/\bBOARDING\s*(?:POINT|PLACE|AT)\b/.test(upper)) bus += 30;
  if (/\bDROPPING\s*(?:POINT|PLACE|AT)\b/.test(upper)) bus += 30;
  if (/\bSERVICE\s*(?:NO|NUMBER|CODE|TYPE)\b/.test(upper)) bus += 20;
  if (/\bTRIP\s*CODE\b/.test(upper)) bus += 25;
  if (/\bDEPOT\b/.test(upper)) bus += 20;
  if (/\bCONDUCTOR\b|\bDRIVER\b/.test(upper)) bus += 15;
  if (/\bSEATER\b|\bSLEEPER\b/.test(upper)) bus += 15;
  if (/\bWAY\s*BILL\b|\bWAYBILL\b/.test(upper)) bus += 20;
  if (/\bBUS\s*STAND\b|\bBUS\s*STATION\b/.test(upper)) bus += 20;
  if (/\bPLATFORM\s*NO\b/.test(upper) && busOperator) bus += 10;

  // "Sleeper" is genuinely ambiguous — SL is a rail class and a bus body type — so it
  // is only allowed to speak when nothing else in the document contradicts it.
  if (/\bSLEEPER\b/.test(upper) && !/\bCOACH\b|\bBERTH\b/.test(upper)) bus += 5;

  const total = Math.max(rail, bus);
  if (total === 0) return { mode: null, score: 0, rail, bus };

  const mode = rail >= bus ? Mode.RAIL : Mode.BUS;

  return {
    mode,
    // Capped below the flight adapter's barcode-backed 100: without a structured
    // source we are always inferring, and the score should say so.
    score: Math.min(total, 85),
    rail,
    bus,
    // A near-tie means the document used vocabulary from both worlds.
    ambiguous: rail > 0 && bus > 0 && Math.abs(rail - bus) < 20,
    operatorMatched: Boolean(railOperator || busOperator),
  };
}

function detect(context) {
  const text = toPlainText(context.lines || []);

  // A retiring room is lodging that happens to be sold by a railway. Shaping it as a
  // journey would invent an origin and destination that do not exist, so it is
  // declined here and left to an adapter that can represent a stay.
  if (RETIRING_ROOM.test(text) && !/\bTRAIN\s*(?:NO|NUMBER)\b/i.test(text)) return 0;

  const result = classify(context);
  return result.score >= 40 ? result.score : 0;
}

// ────────────────────────────── vocabulary ──────────────────────────────

/**
 * Per-mode labels and patterns.
 *
 * Field *keys* stay identical across modes so that everything downstream — the pass
 * builder, the review screen — reads one shape. Only what the user sees changes.
 */
const VOCAB = {
  [Mode.RAIL]: {
    providerLabel: 'Operator',
    serviceLabel: 'Train',
    servicePatterns: [
      /\btrain\s*(?:no\.?|number|#)\b/i,
      /\btrain\s*name\s*(?:&|and)?\s*(?:no\.?|number)?\b/i,
      /\btrain\b/i,
      /\bservice\s*(?:no\.?|number)\b/i,
    ],
    originPatterns: [/\bfrom\b/i, /\bboarding\s*station\b/i, /\bsource\s*station\b/i, /\borigin\b/i, /\bdeparture\s*station\b/i],
    destinationPatterns: [/\bto\b/i, /\bdestination\s*station\b/i, /\bdestination\b/i, /\barrival\s*station\b/i, /\balighting\s*(?:at|station)\b/i],
    seatLabel: 'Berth',
    seatLabelPlural: 'Berths',
    seatPatterns: [/\bberth\s*(?:no\.?|number)?\b/i, /\bseat\s*(?:no\.?|number)?\b/i, /\bcoach\s*(?:&|and)?\s*berth\b/i],
    transitType: 'PKTransitTypeTrain',
    typeName: 'train',
  },
  [Mode.BUS]: {
    providerLabel: 'Operator',
    serviceLabel: 'Service',
    servicePatterns: [
      /\bservice\s*(?:no\.?|number|code)\b/i,
      /\btrip\s*(?:code|no\.?|number)\b/i,
      /\bbus\s*(?:no\.?|number)\b/i,
      /\broute\s*(?:no\.?|number|code)\b/i,
      /\bservice\s*type\b/i,
    ],
    originPatterns: [/\bboarding\s*(?:point|place|at|station)\b/i, /\bfrom\b/i, /\borigin\b/i, /\bdeparture\s*(?:point|place)\b/i],
    destinationPatterns: [/\bdropping\s*(?:point|place|at)\b/i, /\bto\b/i, /\bdestination\b/i, /\barrival\s*(?:point|place)\b/i, /\balighting\s*(?:point|at)\b/i],
    seatLabel: 'Seat',
    seatLabelPlural: 'Seats',
    seatPatterns: [/\bseat\s*(?:no\.?|number|s)?\b/i, /\bseat\b/i],
    transitType: 'PKTransitTypeBus',
    typeName: 'bus',
  },
};

// ────────────────────────────── field helpers ──────────────────────────────

/** Trims a captured value to the first column, since labels often share a line. */
function firstColumn(value, limit = 48) {
  if (!value) return '';
  return String(value).split(/\s{2,}|\s*\|\s*/)[0].trim().slice(0, limit);
}

/**
 * Tidies an operator name for display.
 *
 * Acronyms stay shouted — IRCTC and KSRTC are how those operators write themselves, and
 * "Irctc" would look like a mistake. Anything longer is title-cased, since ticket text
 * is almost always set in full capitals.
 */
function tidyProvider(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 6 && text === text.toUpperCase()) return text;
  if (/[a-z]/.test(text)) return text;

  return text
    .split(/\s+/)
    .map((word) => (word.length <= 4 && word === word.toUpperCase()
      ? word
      : word[0] + word.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * Extracts a station or stop name.
 *
 * Indian tickets print these as "BENGALURU CY JN (SBC)" or "KSR BENGALURU - SBC". The
 * code in brackets is worth keeping separately: it is short enough for the face of the
 * pass, where the full name would be shrunk to illegibility.
 */
export function parseStation(raw) {
  if (!raw) return null;
  const text = firstColumn(raw, 64);
  if (!text) return null;

  // "Name (CODE)" — the most common form on rail tickets.
  const bracketed = text.match(/^(.*?)[\s(]+\(?\b([A-Z]{2,6})\b\)?\s*$/);
  if (bracketed && bracketed[1].trim().length > 2) {
    return {
      name: tidyName(bracketed[1]),
      code: bracketed[2].toUpperCase(),
      display: tidyName(bracketed[1]),
    };
  }

  // "CODE - Name" or "CODE: Name".
  const leading = text.match(/^\(?\b([A-Z]{2,6})\b\)?\s*[-–:]\s*(.+)$/);
  if (leading && leading[2].trim().length > 2) {
    return {
      name: tidyName(leading[2]),
      code: leading[1].toUpperCase(),
      display: tidyName(leading[2]),
    };
  }

  return { name: tidyName(text), code: null, display: tidyName(text) };
}

/** Converts the shouted uppercase of most ticket text into something readable. */
function tidyName(value) {
  const text = String(value).replace(/[\s,;.-]+$/, '').trim();
  if (!text) return '';
  // Mixed case already means the source cared; leave it alone.
  if (/[a-z]/.test(text)) return text;

  return text
    .split(/\s+/)
    .map((word) => {
      // Station suffixes and abbreviations read wrong in title case.
      if (/^(?:JN|CY|CT|RD|NR|SF|EXP|SPL|MG|KSR|BLR|HYB|MAS|CSMT|LTT|NDLS)$/.test(word)) return word;
      if (word.length <= 2) return word;
      return word[0] + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Reads Indian rail coach-and-berth notation.
 *
 * Handles "S7, 42, LB" and "B2/34/UB" and "A1 12 SIDE LOWER", all of which appear on
 * genuine IRCTC tickets. Coach and berth are separated because Wallet shows them in
 * different fields, and because a passenger looking for coach S7 on a platform needs
 * that value large and alone.
 */
export function parseCoachBerth(raw) {
  if (!raw) return null;
  const text = String(raw).toUpperCase();

  const BERTH_WORDS = {
    'SIDE LOWER': 'SL', 'SIDE UPPER': 'SU', 'SIDE MIDDLE': 'SM',
    'WINDOW SIDE': 'WS', 'CABIN': 'CB', 'COUPE': 'CP',
    'LOWER': 'LB', 'MIDDLE': 'MB', 'UPPER': 'UB',
  };

  let position = null;
  // Longest phrase first: "SIDE LOWER" contains "LOWER", and matching the shorter one
  // would put a passenger at the wrong berth in the right compartment.
  const phrases = Object.keys(BERTH_WORDS).sort((a, b) => b.length - a.length);
  for (const word of phrases) {
    if (text.includes(word)) { position = BERTH_WORDS[word]; break; }
  }
  if (!position) {
    const code = text.match(new RegExp(`(?:^|[^A-Z])(${BERTH_CODES.source.slice(2, -2)})(?:[^A-Z]|$)`));
    if (code) position = code[1];
  }

  // Coach identifiers: S7, B2, A1, HA1, D3, C4, M1, GS.
  const coach = text.match(/\b((?:[SBAHDCEGM]|HA|SLR|GS|UR)\d{0,2})\b(?=[\s/,-]|$)/);
  const number = text.match(/\b(\d{1,3})\b/);

  if (!coach && !number && !position) return null;

  return {
    coach: coach ? coach[1] : null,
    number: number ? number[1] : null,
    position,
    positionName: position ? expandBerth(position) : null,
  };
}

function expandBerth(code) {
  return {
    LB: 'Lower', MB: 'Middle', UB: 'Upper',
    SL: 'Side lower', SU: 'Side upper', SM: 'Side middle',
    WS: 'Window', CB: 'Cabin', CP: 'Coupé',
  }[code] || null;
}

/** Indian reserved-class codes expanded, for the back of the pass. */
const CLASS_NAMES = {
  '1A': 'First AC', '2A': 'Second AC', '3A': 'Third AC', '3E': 'Third AC economy',
  'SL': 'Sleeper', 'CC': 'Chair car', 'EC': 'Executive chair car',
  'EA': 'Executive anubhuti', '2S': 'Second sitting', 'FC': 'First class',
};

// ────────────────────────────── build ──────────────────────────────

async function build(context) {
  const { lines, barcode } = context;
  const classified = classify(context);
  const mode = classified.mode || Mode.RAIL;
  const vocab = VOCAB[mode];
  const text = toPlainText(lines || []);

  const draft = new TicketDraft({
    type: mode,
    style: 'boardingPass',
    transitType: vocab.transitType,
    adapter: 'rail',
    // Nothing here is barcode-backed, so the ceiling is MEDIUM by construction.
    confidence: classified.operatorMatched ? Confidence.MEDIUM : Confidence.LOW,
  });

  draft.barcode = barcode || null;
  draft.mode = mode;

  if (classified.ambiguous) {
    draft.warnings.push(
      `This ticket uses wording from both trains and buses, so we have treated it as a ` +
      `${vocab.typeName} journey. Change it above if that is wrong.`
    );
  }

  // ── Provider ──
  //
  // Preferred from a recognised operator name in the document, because the generic
  // "tallest text near the top" heuristic is easily fooled: on an IRCTC ticket it picks
  // up the class description and reports the operator as "THIRD AC ECONOMY".
  const named = (mode === Mode.RAIL ? RAIL_OPERATORS : BUS_OPERATORS)
    .map((pattern) => text.match(pattern)?.[0])
    .find(Boolean);

  const provider = findProvider(lines);
  const value = named || provider?.value || '';

  draft.set('provider', new Field({
    key: 'provider',
    label: vocab.providerLabel,
    value: tidyProvider(value),
    source: value ? Source.PDF_TEXT : Source.INFERRED,
    confidence: named ? Confidence.MEDIUM : (provider?.confidence || Confidence.LOW),
    region: provider?.region || null,
    required: true,
  }));

  // ── Service (train number / bus service) ──
  const service = findLabelled(lines, vocab.servicePatterns);
  const serviceField = draft.set('service', new Field({
    key: 'service',
    label: vocab.serviceLabel,
    value: firstColumn(service?.value, 40),
    source: service ? Source.PDF_TEXT : Source.INFERRED,
    region: service?.region || null,
    required: true,
    critical: true,
  }));

  // Indian train numbers are five digits; finding one corroborates the label match.
  if (mode === Mode.RAIL) {
    const trainNumber = text.match(/\b(\d{5})\b/);
    if (trainNumber && serviceField.value.includes(trainNumber[1])) {
      serviceField.corroborate(Source.PDF_TEXT);
    } else if (trainNumber && !serviceField.value) {
      serviceField.value = trainNumber[1];
      serviceField.confidence = Confidence.LOW;
      serviceField.warn('Taken from a five-digit number on the ticket — please check it.', 'guessed-train');
    }
  }

  // ── Route ──
  buildRoute(draft, lines, vocab);

  // ── Date and times ──
  buildTimes(draft, lines, mode);

  // ── Seating ──
  buildSeating(draft, lines, vocab, mode);

  // ── Booking reference ──
  const pnr = findLabelled(lines, [
    /\bPNR\s*(?:no\.?|number)?\b/i,
    /\bbooking\s*(?:ref\w*|id|no\.?|number|code)\b/i,
    /\bticket\s*(?:no\.?|number)\b/i,
    /\breservation\s*(?:no\.?|number|code)\b/i,
    /\btransaction\s*id\b/i,
  ]);
  draft.set('pnr', new Field({
    key: 'pnr',
    label: mode === Mode.RAIL ? 'PNR' : 'Booking ref',
    value: firstColumn(pnr?.value, 24).split(/\s/)[0],
    source: pnr ? Source.PDF_TEXT : Source.INFERRED,
    region: pnr?.region || null,
    required: true,
    critical: true,
  }));

  // ── Passenger ──
  //
  // Read from the passenger table where there is one. Indian rail tickets list
  // travellers in a table whose status cell carries the coach and berth — "CNF/M1/17/LOWER"
  // — so the table is the only place several golden-rule fields exist at all. Falling
  // back to a label search would find the section heading and report the field as
  // "# Name".
  const table = readPassengerTable(lines);
  const passengerFromTable = table?.rows?.[0]?.name || null;

  const passenger = findLabelled(lines, [
    /\bpassenger\s*(?:name|details)?\b/i,
    /\btraveller\s*name\b/i,
    /\bname\s*of\s*(?:the\s*)?passenger\b/i,
  ]);

  const passengerField = draft.set('passenger', new Field({
    key: 'passenger',
    label: 'Passenger',
    value: passengerFromTable || firstColumn(passenger?.value, 40),
    source: (passengerFromTable || passenger) ? Source.PDF_TEXT : Source.INFERRED,
    region: table?.rows?.[0]?.line || passenger?.region || null,
    critical: true,
  }));

  // Additional travellers belong on the back of the pass rather than being dropped.
  if (table?.rows?.length > 1) {
    draft.passengers = table.rows.map((row) => row.name).filter(Boolean);
    passengerField.note = `${table.rows.length} passengers on this booking.`;
  }

  // ── Mode-specific extras ──
  if (mode === Mode.RAIL) buildRailExtras(draft, lines, text, table);
  else buildBusExtras(draft, lines, text);

  // ── Honesty about the absent barcode ──
  if (!barcode) {
    draft.warnings.push(
      `No barcode was found on this ticket, so the pass will carry your booking ` +
      `reference as text instead. Some conductors will want to see the original.`
    );
  }

  return draft;
}

function buildRoute(draft, lines, vocab) {
  const originFound = findLabelled(lines, vocab.originPatterns);
  const destinationFound = findLabelled(lines, vocab.destinationPatterns);

  const origin = parseStation(originFound?.value);
  const destination = parseStation(destinationFound?.value);

  const originField = draft.set('origin', new Field({
    key: 'origin',
    label: 'From',
    value: origin?.code || origin?.display || '',
    source: originFound ? Source.PDF_TEXT : Source.INFERRED,
    region: originFound?.region || null,
    required: true,
    critical: true,
    note: origin?.name && origin?.code ? origin.name : null,
  }));

  const destinationField = draft.set('destination', new Field({
    key: 'destination',
    label: 'To',
    value: destination?.code || destination?.display || '',
    source: destinationFound ? Source.PDF_TEXT : Source.INFERRED,
    region: destinationFound?.region || null,
    required: true,
    critical: true,
    note: destination?.name && destination?.code ? destination.name : null,
  }));

  // Full names are kept alongside the codes: the face of the pass wants "SBC", the
  // back wants "KSR Bengaluru City Junction".
  if (origin?.name) draft.originName = origin.name;
  if (destination?.name) draft.destinationName = destination.name;

  // A route that starts and ends in the same place is always a mis-read, most often a
  // label matching itself. Better to say so than to print it.
  if (originField.value && originField.value === destinationField.value) {
    originField.warn('Origin and destination came out the same — please correct one.', 'same-station');
    destinationField.warn('Origin and destination came out the same — please correct one.', 'same-station');
  }

  return { origin, destination };
}

function buildTimes(draft, lines, mode) {
  const dateFound = findLabelled(lines, [
    /\b(?:date\s*of\s*(?:journey|travel|departure)|journey\s*date|travel\s*date|departure\s*date|doj)\b/i,
    /\bdate\b/i,
  ]);
  const parsed = dateFound ? parseDate(dateFound.value) : null;

  const dateField = draft.set('date', new Field({
    key: 'date',
    label: 'Date',
    value: parsed?.date ? parsed.date.toISOString().slice(0, 10) : '',
    source: dateFound ? Source.PDF_TEXT : Source.INFERRED,
    type: 'date',
    region: dateFound?.region || null,
    required: true,
    critical: true,
  }));

  // A date read the wrong way round puts someone at a platform on the wrong day, so an
  // ambiguous numeric date is surfaced with both readings rather than resolved.
  if (parsed?.ambiguous) {
    dateField.value = '';
    dateField.confidence = Confidence.LOW;
    dateField.warn(
      `"${dateFound.value.trim()}" could be either day-month or month-day. Please pick the right one.`,
      'ambiguous-date',
    );
    dateField.options = parsed.candidates.map((candidate) => candidate.toISOString().slice(0, 10));
  }

  const departure = findLabelled(lines, [
    /\b(?:departure|departs?|dep)\s*(?:time)?\b/i,
    /\bscheduled\s*departure\b/i,
    /\bboarding\s*time\b/i,
    /\breporting\s*time\b/i,
  ]);
  const arrival = findLabelled(lines, [
    /\b(?:arrival|arrives?|arr)\s*(?:time)?\b/i,
    /\bscheduled\s*arrival\b/i,
  ]);

  addTime(draft, 'departureTime', 'Departs', departure);
  addTime(draft, 'arrivalTime', 'Arrives', arrival);

  // Reporting time is a distinct promise from departure time on road transport — buses
  // routinely ask passengers to be at the pickup fifteen minutes early — so it is kept
  // as its own field rather than folded into departure.
  if (mode === Mode.BUS) {
    const reporting = findLabelled(lines, [/\breporting\s*(?:time|at)\b/i, /\breport\s*(?:by|at)\b/i]);
    if (reporting) addTime(draft, 'reportingTime', 'Report by', reporting);
  }
}

function addTime(draft, key, label, found) {
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
    field.warn(`We could not read "${firstColumn(found.value, 24)}" as a time.`, 'unparsed-time');
    field.confidence = Confidence.LOW;
  }

  // Rail and road timetables are always local to the station. There is no zone data to
  // attach, so the pass must show the wall-clock time exactly as printed and never
  // convert it — handled downstream by ignoresTimeZone.
  field.localWallClock = true;
  return field;
}

/**
 * Builds coach and seat fields.
 *
 * A single booking commonly covers several passengers, and their seats need not be
 * adjacent or even in the same coach — G1–G9 in one coach and C1–C3 in another is an
 * ordinary family booking. The face of the pass therefore shows a condensed summary,
 * and the full allocation is carried on the back where it can wrap freely.
 */
function buildSeating(draft, lines, vocab, mode) {
  const seatFound = findLabelled(lines, vocab.seatPatterns);
  const coachFound = findLabelled(lines, [/\bcoach\s*(?:no\.?|number)?\b/i, /\bbogie\b/i, /\bcar\s*(?:no\.?|number)\b/i]);

  const raw = seatFound?.value || '';
  const parsed = parseSeats(raw);
  const coachBerth = mode === Mode.RAIL ? parseCoachBerth(raw) : null;

  // ── Coach ──
  const coachValue = firstColumn(coachFound?.value, 8) || coachBerth?.coach || '';
  if (mode === Mode.RAIL || coachValue) {
    draft.set('coach', new Field({
      key: 'coach',
      label: 'Coach',
      value: coachValue,
      source: coachFound || coachBerth?.coach ? Source.PDF_TEXT : Source.INFERRED,
      region: coachFound?.region || null,
      // A golden-rule field: the coach is the first thing checked at the door of a train.
      critical: mode === Mode.RAIL,
    }));
  }

  // ── Seats or berths ──
  const list = parsed?.seats || [];
  const multiple = list.length > 1;

  const seatField = draft.set('seat', new Field({
    key: 'seat',
    label: multiple ? vocab.seatLabelPlural : vocab.seatLabel,
    value: parsed?.summary || parsed?.display || coachBerth?.number || firstColumn(raw, 24),
    source: seatFound ? Source.PDF_TEXT : Source.INFERRED,
    region: seatFound?.region || null,
    // A golden-rule field in every mode: seat, berth or screen position is precisely
    // what someone is asked for once they are aboard.
    critical: true,
  }));

  if (multiple) {
    // The complete allocation, always preserved even when the face shows a count.
    draft.allSeats = list;
    draft.seatOverflow = Boolean(parsed?.overflowed);

    seatField.note = parsed?.overflowed
      ? `All ${list.length} ${vocab.seatLabelPlural.toLowerCase()} are listed on the back of the pass.`
      : `${list.length} ${vocab.seatLabelPlural.toLowerCase()} on this booking.`;
  }

  if (seatFound && !parsed && !coachBerth) {
    seatField.warn(
      `We could not make sense of "${firstColumn(raw, 24)}" as a ${vocab.seatLabel.toLowerCase()} number.`,
      'unparsed-seat',
    );
  }

  // ── Berth position ──
  if (mode === Mode.RAIL && coachBerth?.position) {
    draft.set('berthPosition', new Field({
      key: 'berthPosition',
      label: 'Berth type',
      value: coachBerth.positionName || coachBerth.position,
      source: Source.PDF_TEXT,
    }));
  }
}

/**
 * Finds the passenger table.
 *
 * Its shape is remarkably consistent across Indian rail operators: a row per traveller
 * with name, age, gender and a status cell. The status is the valuable part — it holds
 * the coach and berth, which appear nowhere else on the ticket.
 *
 * Two arrangements exist. The printed ticket packs everything into one cell,
 * "CNF/M1/17/LOWER"; the confirmation email gives Status, Coach and Berth their own
 * columns. Both are read, because a ticket that only works when printed is no use to
 * someone holding a phone.
 */
export function readPassengerTable(lines) {
  const table = readTable(lines, {
    name: /^#?\s*name\b/i,
    age: /\bage\b/i,
    gender: /\bgender\b/i,
    booking: /\bbooking\s*status\b/i,
    current: /\bcurrent\s*status\b/i,
    // Anchored, so a plain "Status" heading does not also claim the booking and current
    // status columns when a ticket carries all three.
    status: /^\s*status\s*$/i,
    coach: /^\s*coach\b/i,
    berth: /^\s*seat\s*\/|^\s*(?:seat|berth)\b/i,
  }, { minMatch: 3 });

  if (!table) return null;

  // Rows are numbered on the ticket — "1. SAMPLE R" — because the column header is
  // "# Name". The number belongs to the table, not to the passenger.
  for (const row of table.rows) {
    if (row.name) row.name = row.name.replace(/^\s*\d+\s*[.)]\s*/, '').trim();
  }

  return table;
}

/**
 * Reads an Indian rail status cell.
 *
 * "CNF/M1/17/LOWER" — confirmed, coach M1, berth 17, lower. The current status is
 * preferred over the booking status wherever both exist, because a waitlisted or RAC
 * ticket can be confirmed later and it is the *current* allocation the passenger will
 * be asked for.
 */
export function parseStatusCell(raw) {
  if (!raw) return null;

  const text = String(raw).toUpperCase().replace(/\s+/g, '');
  const parts = text.split('/').filter(Boolean);
  if (!parts.length) return null;

  const status = parts[0].match(/^(CNF|RAC|WL|CAN|TQWL|PQWL|RLWL|GNWL)/)?.[1] || null;

  // Coach identifiers: S7, B2, A1, HA1, M1, D3, GS.
  const coach = parts.find((part) => /^(?:[SBAHDCEGM]|HA|SLR|GS|UR)\d{1,2}$/.test(part)) || null;
  const berth = parts.find((part) => /^\d{1,3}$/.test(part)) || null;

  const positions = {
    LOWER: 'LB', MIDDLE: 'MB', UPPER: 'UB',
    SIDELOWER: 'SL', SIDEUPPER: 'SU', SIDEMIDDLE: 'SM',
    WINDOWSIDE: 'WS', CABIN: 'CB', COUPE: 'CP',
    LB: 'LB', MB: 'MB', UB: 'UB', SL: 'SL', SU: 'SU', SM: 'SM',
  };

  let position = null;
  // Longest first: "SIDELOWER" contains "LOWER", and matching the shorter one would put
  // a passenger at the wrong berth in the right compartment.
  for (const key of Object.keys(positions).sort((a, b) => b.length - a.length)) {
    if (parts.some((part) => part === key)) { position = positions[key]; break; }
  }

  if (!status && !coach && !berth && !position) return null;

  return { status, coach, berth, position, positionName: position ? expandBerth(position) : null };
}

function buildRailExtras(draft, lines, text, table) {
  // ── Coach and berth from the passenger table ──
  //
  // These are golden-rule fields and appear nowhere else on an IRCTC ticket, so the
  // table is not an optimisation — without it they are simply missing.
  const row = table?.rows?.[0];
  const cell = row?.current || row?.booking || row?.status;
  const parsed = parseStatusCell(cell);

  // Where the email lays Status, Coach and Berth out as separate columns, those columns
  // are the better source: they need no unpicking and cannot be misread.
  const coachColumn = row?.coach?.trim() || null;
  const berthColumn = row?.berth?.trim().match(/\d{1,3}/)?.[0] || null;

  const coach = coachColumn || parsed?.coach;
  const berth = berthColumn || parsed?.berth;

  if (coach && !draft.value('coach')) {
    draft.set('coach', new Field({
      key: 'coach', label: 'Coach', value: coach, source: Source.PDF_TEXT, critical: true,
    }));
  }

  if (berth && !draft.value('seat')) {
    draft.set('seat', new Field({
      key: 'seat', label: 'Berth', value: berth, source: Source.PDF_TEXT, critical: true,
    }));
  }

  if (parsed?.positionName && !draft.value('berthPosition')) {
    draft.set('berthPosition', new Field({
      key: 'berthPosition', label: 'Berth type', value: parsed.positionName, source: Source.PDF_TEXT,
    }));
  }

  // ── Class ──
  const classFound = findLabelled(lines, [/\bclass\b/i, /\bcoach\s*class\b/i, /\bjourney\s*class\b/i]);
  const raw = firstColumn(classFound?.value, 24).toUpperCase();

  // The reserved-class code is the reliable part. IRCTC prints it in brackets — "(3E)"
  // — often on a different line from the words, so the code is sought across the whole
  // document rather than only in whatever the label search returned.
  const code = raw.match(RAIL_CLASSES) || text.match(/\((1A|2A|3A|3E|2S|SL|CC|EC|EA|FC)\)/i);
  const spelled = text.match(/\b(FIRST AC|SECOND AC|THIRD AC ECONOMY|THIRD AC|SLEEPER|CHAIR CAR|EXECUTIVE CHAIR CAR|SECOND SITTING)\b/i);

  if (code || spelled || classFound) {
    const value = code ? code[1] || code[0] : (spelled ? spelled[1] : raw);
    const field = draft.set('class', new Field({
      key: 'class',
      label: 'Class',
      value: String(value).toUpperCase(),
      source: Source.PDF_TEXT,
      region: classFound?.region || null,
    }));

    const expanded = CLASS_NAMES[String(value).toUpperCase()];
    if (expanded) field.note = expanded;
    else if (spelled && code) field.note = spelled[1];
  }

  // ── Booking status ──
  // CNF, RAC and WL are not decoration: a passenger holding RAC has a seat but not a
  // berth, and a waitlisted passenger may not travel at all. Surfacing it prominently
  // is the honest thing to do.
  const fromTable = parsed?.status;

  // The prose fallback scans the whole document, which includes column headings. The
  // IRCTC email heads its berth column "Seat / Berth / WL No", and reading a status of
  // "WL" from it would tell a confirmed passenger they are waitlisted — alarming, and
  // completely wrong. A bare "WL" is only a status when a number follows it.
  const prose = text
    .replace(/\b(?:seat|berth|coach)\s*\/[^\n]*/gi, ' ')
    .match(/\b(CNF|CONFIRMED|RAC\s*\d*|WL\s*\d+|WAITLIST(?:ED)?|CAN|TQWL\s*\d*|PQWL\s*\d*|RLWL\s*\d*|GNWL\s*\d*)\b/i);

  const status = fromTable ? [fromTable, fromTable] : prose;

  if (status) {
    const value = status[1].toUpperCase();
    const field = draft.set('status', new Field({
      key: 'status',
      label: 'Status',
      value,
      source: Source.PDF_TEXT,
    }));

    if (/^RAC/.test(value)) {
      field.note = 'Reservation against cancellation — you have a seat, not a full berth.';
    } else if (/WL|WAITLIST/.test(value)) {
      field.warn(
        'This booking is waitlisted. Check your status before travelling — it may not be confirmed.',
        'waitlisted',
      );
    }
  }

  // ── Quota ──
  const quota = findLabelled(lines, [/\bquota\b/i]);
  if (quota) {
    draft.set('quota', new Field({
      key: 'quota',
      label: 'Quota',
      value: firstColumn(quota.value, 16),
      source: Source.PDF_TEXT,
      region: quota.region,
    }));
  }

  // ── Platform ──
  const platform = findLabelled(lines, [/\bplatform\s*(?:no\.?|number)?\b/i]);
  if (platform) {
    const field = draft.set('platform', new Field({
      key: 'platform',
      label: 'Platform',
      value: firstColumn(platform.value, 8),
      source: Source.PDF_TEXT,
      region: platform.region,
    }));
    field.note = 'Platforms change — check the station boards.';
  }

  // Chart preparation determines whether the coach and berth shown are final.
  if (/\bchart\s*(?:is\s*)?not\s*prepared\b/i.test(text)) {
    draft.warnings.push(
      'The chart was not prepared when this ticket was issued, so your coach and berth may still change.'
    );
  }
}

function buildBusExtras(draft, lines, text) {
  // Boarding and dropping points are the road equivalent of gates, and far more
  // consequential: a bus pickup is often an unmarked spot on a named road, so the full
  // text is preserved rather than trimmed to a code.
  const boarding = findLabelled(lines, [
    /\bboarding\s*(?:point|place|at|address)\b/i,
    /\bpick[-\s]?up\s*(?:point|place|at)?\b/i,
  ]);
  if (boarding) {
    const field = draft.set('boardingPoint', new Field({
      key: 'boardingPoint',
      label: 'Boarding point',
      value: firstColumn(boarding.value, 80),
      source: Source.PDF_TEXT,
      region: boarding.region,
    }));
    field.note = 'Reach a few minutes early — buses do not always wait.';
  }

  const dropping = findLabelled(lines, [
    /\bdropping\s*(?:point|place|at|address)\b/i,
    /\bdrop[-\s]?off\s*(?:point|place|at)?\b/i,
  ]);
  if (dropping) {
    draft.set('droppingPoint', new Field({
      key: 'droppingPoint',
      label: 'Dropping point',
      value: firstColumn(dropping.value, 80),
      source: Source.PDF_TEXT,
      region: dropping.region,
    }));
  }

  // ── Service type ──
  // "Airavat Club Class" or "Volvo Multi-Axle Sleeper" tells a passenger what they
  // bought far better than a route code does.
  const serviceType = findLabelled(lines, [/\bservice\s*type\b/i, /\bbus\s*type\b/i, /\bclass\s*of\s*service\b/i, /\bvehicle\s*type\b/i]);
  if (serviceType) {
    draft.set('serviceType', new Field({
      key: 'serviceType',
      label: 'Bus type',
      value: firstColumn(serviceType.value, 40),
      source: Source.PDF_TEXT,
      region: serviceType.region,
    }));
  }

  // ── Depot / operator division ──
  const depot = findLabelled(lines, [/\bdepot\b/i, /\bdivision\b/i]);
  if (depot) {
    draft.set('depot', new Field({
      key: 'depot',
      label: 'Depot',
      value: firstColumn(depot.value, 32),
      source: Source.PDF_TEXT,
      region: depot.region,
    }));
  }

  // ── Vehicle registration ──
  const vehicle = text.match(/\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{4})\b/);
  if (vehicle) {
    draft.set('vehicle', new Field({
      key: 'vehicle',
      label: 'Vehicle',
      value: vehicle[1].replace(/\s+/g, ' ').trim(),
      source: Source.PDF_TEXT,
      confidence: Confidence.LOW,
      note: 'Registration number printed on the ticket — buses are often substituted.',
    }));
  }
}

export default register({
  id: 'rail',
  label: 'Train or bus',
  detect,
  build,
});
