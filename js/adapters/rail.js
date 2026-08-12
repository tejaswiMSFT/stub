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
import { readTable, splitColumns } from '../text.js';
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

  /*
   * Rail vocabulary in the languages rail tickets are actually printed in.
   *
   * A Deutsche Bahn ticket was refused outright — "this doesn't look like a ticket" —
   * while carrying the words Fahrkarte, Wagen, Liegeplatz and Abteilwagen, and an Aztec
   * code plainly on its face. Every signal above is English, so a European rail ticket
   * scored zero on a document that says "railway ticket" four times in German.
   *
   * These are the words that appear on the ticket itself, not a translation exercise:
   * German, French, Italian, Spanish and Dutch cover the operators most likely to be
   * met by someone whose ticket this app is meant to hold. Nothing here is
   * operator-specific — DB may reprint its tickets tomorrow, but a Wagen will still be
   * a Wagen.
   */
  if (/\bFAHRKARTE\b|\bFAHRSCHEIN\b|\bZUGBINDUNG\b|\bREISEVERBINDUNG\b/.test(upper)) rail += 40;
  if (/\bWAGEN\b|\bABTEIL\w*\b|\bLIEGEPL\w+\b|\bSITZPLATZ\b|\bGLEIS\b/.test(upper)) rail += 25;
  if (/\bBILLET\b|\bVOITURE\b|\bQUAI\b|\bTRAJET\b/.test(upper)) rail += 25;
  if (/\bBIGLIETTO\b|\bCARROZZA\b|\bBINARIO\b/.test(upper)) rail += 25;
  if (/\bBILLETE\b|\bCOCHE\b|\bAND[EÉ]N\b|\bVAG[OÓ]N\b/.test(upper)) rail += 25;
  if (/\bTREINKAARTJE\b|\bSPOOR\b|\bRIJTUIG\b/.test(upper)) rail += 25;
  if (/\bBAHN\b|\bZUG\b|\bTRENO\b|\bTREN\b|\bTREIN\b/.test(upper)) rail += 15;
  if (/\bONLINE-?TICKET\b/.test(upper) && /\bBAHN\b|\bZUG\b/.test(upper)) rail += 20;

  /*
   * The phrases printed on an Indian counter ticket, which is a photograph problem.
   *
   * A Bangalore–Pune reservation was refused with 39 of 240 words read confidently: a
   * dot-matrix ticket, printed in Hindi and English on faded pink stock, photographed.
   * The signals were all present and all just missed — "COACH SEAT/BERTH" came back as
   * "COACH SEATAERTH", so `\bBERTH\b` failed on a word that was right there.
   *
   * So these are matched loosely, without word boundaries on the right, because OCR
   * routinely welds the next character on. That is a real weakening and it is confined
   * to phrases specific enough to survive it: no other document says "journey cum
   * reservation".
   */
  if (/JOURNEY\s*CUM\s*RESERVATION/.test(upper)) rail += 45;
  if (/HAPPY\s*JOURNEY/.test(upper)) rail += 20;
  if (/RESERVATION\s*(?:TICKET|SLIP|VOUCHER)/.test(upper)) rail += 25;
  if (/\bCOACH\s*SEAT/.test(upper)) rail += 30;
  if (/\bSEAT\s*[\/A-Z]?\s*BERTH/.test(upper)) rail += 30;
  if (/\bT\.?\s*AUTHORITY\b|\bCONC\b.*\bSF\.?CH\b/.test(upper)) rail += 20;
  if (/\bCY\s*JN\b|\b[A-Z]{3,}\s+JN\b/.test(upper)) rail += 15;

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

  /*
   * A day pass is a bus ticket, and the commonest one in a city.
   *
   * BMTC and KSRTC daily passes were refused. They carry no barcode, no seat and no
   * reservation — a conductor reads them — so nothing above fires, and a pass someone
   * uses every working day was the thing this app was least able to hold.
   *
   * The text also arrives badly: these are photographs of small printed cards, half in
   * Kannada, and Tesseract reads only English. "GOLD Day Pass" came back as "WHINE GOLD
   * Day PASS". What survives is the English half, so that is what these match.
   */
  if (/\bDAY\s*PASS\b|\bDAILY\s*PASS\b/.test(upper)) bus += 40;
  if (/\bMONTHLY\s*PASS\b|\bSEASON\s*(?:TICKET|PASS)\b/.test(upper)) bus += 35;
  if (/\bBUS\s*PASS\b/.test(upper)) bus += 40;
  if (/\bVAYU\s*VAJRA\b|\bVAYUVAJRA\b|\bVOLVO\b/.test(upper)) bus += 25;
  if (/\bCONDUCTOR'?S?\s*COPY\b|\bPASSENGER'?S?\s*COPY\b/.test(upper)) bus += 20;

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
      // "Train No. & Name" before the looser "Train No", because a pattern that matches
      // less of a compound label leaves the rest behind and the value is read from the
      // wrong cell. An ixigo-issued slip lays out "Train No. & Name : 15708/ASR KIR
      // EXPRESS" beside "Date & Time of Booking", and matching only "Train No" returned
      // the booking timestamp.
      /\btrain\s*(?:no\.?|number|#)?\s*(?:&|and)\s*name\b/i,
      /\btrain\s*name\s*(?:&|and)?\s*(?:no\.?|number)?\b/i,
      /\btrain\s*(?:no\.?|number|#)\b/i,
      /\btrain\b/i,
      /\bservice\s*(?:no\.?|number)\b/i,
    ],
    originPatterns: [/\bfrom\b/i, /\bboarding\s*station\b/i, /\bsource\s*station\b/i, /\borigin\b/i, /\bdeparture\s*station\b/i],
    destinationPatterns: [/\bto\b/i, /\bdestination\s*station\b/i, /\bdestination\b/i, /\barrival\s*station\b/i, /\balighting\s*(?:at|station)\b/i],
    // "Seat", not "Berth": the number is the seat, and the berth is whether it is lower,
    // middle or upper — which is carried separately in `berthPosition`. Calling both
    // "Berth" left the pass showing that word twice against two different kinds of value.
    seatLabel: 'Seat',
    seatLabelPlural: 'Seats',
    seatPatterns: [/\bberth\s*(?:no\.?|number)?\b/i, /\bseat\s*(?:no\.?|number)?\b/i, /\bcoach\s*(?:&|and)?\s*berth\b/i],
    transitType: 'PKTransitTypeTrain',
    typeName: 'train',
  },
  [Mode.BUS]: {
    providerLabel: 'Operator',
    serviceLabel: 'Service',
    servicePatterns: [
      /*
       * "#" cannot carry a trailing word boundary.
       *
       * AbhiBus prints "Service # BNG-Mumbai Multi Axle Volvo 4", and `#\b` never matches
       * there: a boundary needs a word character on one side, and "# " has none on
       * either. Written as `#\b` the pattern silently failed and Service was blank on
       * every bus ticket in the corpus. The boundary belongs inside the worded
       * alternatives, not after the group.
       */
      /\bservice\s*(?:(?:no\.?|number|code)\b|#)/i,
      /\btrip\s*(?:(?:code|no\.?|number)\b|#)/i,
      /\bbus\s*(?:(?:no\.?|number)\b|#)/i,
      /\broute\s*(?:(?:no\.?|number|code)\b|#)/i,
      /\bservice\s*type\b/i,
    ],
    /*
     * A boarding point is a place, and a label naming something *about* it is not that
     * place. "Boarding Point Ph. No.: 8724069239 / 9954781942" heads a redBus e-ticket,
     * and the pass reported the journey as starting at a telephone number.
     *
     * The same trap as "Passenger Mobile No" on the flight side: a bare label followed by
     * a qualifier belongs to the qualifier, not the label.
     */
    originPatterns: [
      /\bboarding\s*(?:point|place|at|station)\b(?!\s*(?:ph\b|phone|mobile|contact|no\.?\b|number|tel|details?\b))/i,
      /\bfrom\b/i,
      /\borigin\b/i,
      /\bdeparture\s*(?:point|place)\b/i,
    ],
    destinationPatterns: [
      /\bdropping\s*(?:point|place|at)\b(?!\s*(?:ph\b|phone|mobile|contact|no\.?\b|number|tel|details?\b))/i,
      /\bto\b/i,
      /\bdestination\b/i,
      /\barrival\s*(?:point|place)\b/i,
      /\balighting\s*(?:point|at)\b/i,
    ],
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

  /*
   * A reference has a shape, and a bare word is not it.
   *
   * When the value beside a label cannot be found, the search falls to the line below —
   * which on an ixigo-issued slip is "Transaction ID: 3RJ4...", so the PNR was reported
   * as the word "Transaction". Every booking reference in use is digits, or letters and
   * digits mixed; none is a single dictionary word. Rejecting a candidate with no digit
   * at all costs nothing and removes a whole class of confident nonsense.
   */
  const pnrValue = firstColumn(pnr?.value, 24).split(/\s/)[0];
  const plausible = /\d/.test(pnrValue) && pnrValue.length >= 4;

  draft.set('pnr', new Field({
    key: 'pnr',
    label: mode === Mode.RAIL ? 'PNR' : 'Booking ref',
    value: plausible ? pnrValue : '',
    source: (pnr && plausible) ? Source.PDF_TEXT : Source.INFERRED,
    region: plausible ? pnr?.region || null : null,
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
    // "Passenger Name" and "Passenger Details" before the bare word, so the more specific
    // caption wins where both are present.
    /\bpassenger\s*(?:name|details)\b/i,
    /\bpax\s*(?:name|details?)?\b/i,
    /\btraveller?\s*name\b/i,
    /\bname\s*of\s*(?:the\s*)?passenger\b/i,
    // Bare "Passenger" last, and never where it introduces something else about the
    // passenger rather than the passenger: an ixigo slip prints "Passenger Mobile No :
    // 9794998703", which matched and put a phone number on the pass as a person's name.
    /\bpassenger\b(?!\s*(?:mobile|phone|contact|email|e-?mail|address|count|type|no\b|nos\b|number))/i,
  ]);

  /*
   * A name is not a number.
   *
   * The last guard, and the one that would have caught the phone number whatever the
   * label had been. Names do not contain digits; every value on a ticket that does is
   * something else — a mobile, a count, an age.
   */
  const labelledName = firstColumn(passenger?.value, 40);
  const plausibleName = labelledName && !/\d/.test(labelledName) ? labelledName : '';

  const passengerField = draft.set('passenger', new Field({
    key: 'passenger',
    label: 'Passenger',
    value: passengerFromTable || plausibleName,
    source: (passengerFromTable || plausibleName) ? Source.PDF_TEXT : Source.INFERRED,
    region: table?.rows?.[0]?.line || (plausibleName ? passenger?.region : null) || null,
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

  // ── The barcode, which outranks everything read off the page ──
  applyIrctcRecord(draft, barcode);

  // ── Honesty about the absent barcode ──
  if (!barcode) {
    draft.warnings.push(
      `No barcode was found on this ticket, so the pass will carry your booking ` +
      `reference as text instead. Some conductors will want to see the original.`
    );
  }

  return draft;
}

/**
 * The record inside an IRCTC QR code.
 *
 * Indian Railways prints a complete, labelled copy of the reservation in the QR — PNR,
 * every passenger, train, class, date, origin and destination — and until now it was
 * decoded, stored and then ignored while the same fields were guessed from OCR of the
 * printed page. Measured across three real tickets, the barcode was right where OCR was
 * wrong every time:
 *
 *   Train "12618 6 / / MNGLA MINGLA" against "12618 / MNGLA LKSDP EXP".
 *   Origin "MUMBAI" against "PANVEL - PNVL".
 *   Destination "New Delhi - NDLS ( (new Delhi )" against "NEW DELHI - NDLS".
 *
 * And two of the three carry passengers OCR never found at all — a booking for three
 * showed one, which is precisely the failure that is discovered at the coach door.
 *
 * The format is one `Key:Value` a line, values never containing a comma, with each
 * passenger introduced by a repeated `Passenger Name` and their details indented beneath.
 *
 * @returns the fields found, or null if this is not an IRCTC record
 */
export function parseIrctcRecord(text) {
  if (!text) return null;

  // Two labels, not one. A single "PNR No." could appear in any operator's payload;
  // together with a train number it is unmistakably this format.
  if (!/\bPNR\s*No\.?\s*:/i.test(text) || !/\bTrain\s*No\.?\s*:/i.test(text)) return null;

  const fields = {};
  const passengers = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s\t]+/, '').replace(/,\s*$/, '').trim();
    if (!line) continue;

    const split = line.indexOf(':');
    if (split < 1) continue;

    const key = line.slice(0, split).trim().toLowerCase().replace(/\s*\.\s*/g, '').replace(/\s+/g, ' ');
    const value = line.slice(split + 1).trim();
    if (!value) continue;

    // Repeated rather than overwritten: a booking for three prints the label three times.
    if (key === 'passenger name') {
      passengers.push(value);
      continue;
    }

    // First occurrence wins for everything else. "Status" is printed once per passenger
    // and the first belongs to the traveller whose name heads the pass.
    if (!(key in fields)) fields[key] = value;
  }

  return { fields, passengers };
}

/**
 * Overwrites what was read from the page with what the barcode says.
 *
 * Unconditional where the barcode has a value. This is not a merge: a field decoded from
 * a barcode is not a better guess than one read by OCR, it is the operator's own record,
 * and preferring anything else would be choosing a photograph of the truth over the
 * truth. Fields the record does not carry are left exactly as the page gave them.
 */
function applyIrctcRecord(draft, barcode) {
  const record = parseIrctcRecord(barcode?.text);
  if (!record) return;

  const { fields, passengers } = record;

  const set = (key, value, note) => {
    if (!value) return;
    const field = draft.get(key);
    if (!field) return;
    field.value = value;
    field.source = Source.BARCODE;
    field.confidence = Confidence.HIGH;
    field.issues = [];
    if (note) field.note = note;
  };

  /*
   * Stations are parsed, not pasted.
   *
   * The record states "NASHIK ROAD - NK", which is a name and a code together. The rest
   * of the adapter keeps those apart — the face of the pass wants NK, the back wants the
   * full name — and pasting the raw string put both on the front of the card.
   */
  const from = fields.from ? parseStation(fields.from) : null;
  const to = fields.to ? parseStation(fields.to) : null;

  set('origin', from?.code || from?.display, from?.name || null);
  set('destination', to?.code || to?.display, to?.name || null);
  if (from?.name) draft.originName = from.name;
  if (to?.name) draft.destinationName = to.name;

  set('pnr', fields['pnr no']);
  set('quota', fields.quota);
  set('class', fields.class?.replace(/_/g, ' '));
  set('passenger', passengers[0]);
  set('status', fields.status);

  // The train is named by the same field the page reads into — "service" here, since a
  // bus service and a train number are the same slot in this adapter.
  if (fields['train no'] && fields['train name']) {
    set('service', `${fields['train no']} / ${fields['train name']}`);
  }

  // The journey date, which the record states unambiguously — no guessing which of two
  // numbers is the month.
  const journey = parseDate(fields['date of journey'] || fields['scheduled departure']);
  if (journey?.date) {
    set('date', journey.date.toISOString().slice(0, 10));
  }

  if (passengers.length > 1) {
    draft.passengers = passengers;
    const field = draft.get('passenger');
    if (field) field.note = `${passengers.length} passengers on this booking, all from the barcode.`;
  }
}

function buildRoute(draft, lines, vocab) {
  const originFound = findLabelled(lines, vocab.originPatterns);
  const destinationFound = findLabelled(lines, vocab.destinationPatterns);

  const origin = parseStation(originFound?.value);
  const destination = parseStation(destinationFound?.value);

  /*
   * The heading, where a bus ticket states its journey plainly.
   *
   * Every operator prints it: "Guwahati → Duliajan" on redBus, "Bangalore to Pune" on
   * AbhiBus — set large, near the top, above everything else. The labelled fields are
   * about the *stops*, not the journey: a boarding point is "B T M Layout (Pickup
   * Van/Bus) Near Gangotri hospital", which is where to stand, not where you are going.
   * Reported as the route it gave passes reading "BT MLayout (Pickup → Rigi".
   *
   * So the heading wins where there is one. It is preferred over the labels rather than
   * used as a fallback, because it is the more reliable of the two — the stop labels are
   * right about stops and wrong about the journey, which is the field being filled here.
   */
  const heading = vocab.typeName === 'bus' ? routeFromHeading(lines) : null;
  const originValue = heading?.from || origin?.code || origin?.display || '';
  const destinationValue = heading?.to || destination?.code || destination?.display || '';

  const originField = draft.set('origin', new Field({
    key: 'origin',
    label: 'From',
    value: originValue,
    source: (heading || originFound) ? Source.PDF_TEXT : Source.INFERRED,
    region: heading?.region || originFound?.region || null,
    required: true,
    critical: true,
    note: origin?.name && origin?.code ? origin.name : null,
  }));

  const destinationField = draft.set('destination', new Field({
    key: 'destination',
    label: 'To',
    value: destinationValue,
    source: (heading || destinationFound) ? Source.PDF_TEXT : Source.INFERRED,
    region: heading?.region || destinationFound?.region || null,
    required: true,
    critical: true,
    note: destination?.name && destination?.code ? destination.name : null,
  }));

  // Kept for the date, which a bus ticket prints on this same line and nowhere else.
  if (heading?.region) draft.headingLine = heading.region;

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

/**
 * The journey as stated in a bus ticket's heading.
 *
 * "Guwahati → Duliajan", "Bangalore to Pune" — set large and near the top, which is both
 * how a person reads the ticket and how it can be told from the many other pairs of
 * place names further down (boarding landmarks, operator addresses, offer banners).
 *
 * Deliberately strict. A wrong route is worse than a blank one the user is asked to fill,
 * and "to" is an ordinary English word that appears in every terms-and-conditions block
 * on the page.
 */
/**
 * Words that mark a two-column pair as captions rather than a route.
 *
 * "Ticket ID | Order ID", "Bus Operator Name", "Boarding Point" — all two columns of
 * plain words at heading size, all indistinguishable from a route by shape alone.
 */
const CAPTION_ISH = /\b(?:ticket|order|booking|pnr|id|no|number|ref|reference|operator|name|point|details?|status|seat|fare|time|date|passenger|boarding|dropping|address|location|landmark|customer|care|support|help|type|bus|travels?)\b/i;

function routeFromHeading(lines) {
  // Only the top of the page. A heading is a heading by virtue of where it sits, and
  // scanning the whole document finds "Write to us", "Upto 80% Off on Hotel Booking" and
  // every address on the sheet.
  const top = lines.slice(0, 16);
  const tallest = Math.max(...top.map((line) => line.height || 0), 0);

  /*
   * Body text is measured across the whole document, not the top of it.
   *
   * Taken from the top sixteen lines the median is dragged up by the very headings it
   * exists to distinguish — on a sparse ticket half those lines are large, so the median
   * lands between heading and body and the threshold rejects both. The body of a full
   * page is overwhelmingly ordinary text, which is what makes its median stable.
   */
  const heights = lines.map((line) => line.height || 0).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 0;

  /*
   * OCR does not preserve an arrow.
   *
   * The glyph a designer set as → comes back as ">" from Tesseract, and on other tickets
   * as "-" or "»". Measured on a redBus e-ticket, the heading read "Guwahati > Duliajan
   * Thursday, October 3, 2019 ag" — so the arrow has to be matched loosely, and the
   * words around it cannot be anchored to the end of the line, because the date and a
   * stray mark follow on the same line.
   */
  /*
   * Spacing around the arrow cannot be relied on either. A goibibo ticket reads
   * "Jaipur-> Bhim" with no space before it, so requiring one on both sides missed the
   * route entirely. Requiring a space on *either* side is enough to keep it from
   * matching a hyphenated place name like "Jaipur-Ajmer".
   */
  const ARROW = /(?:\s(?:→|➜|➔|»|-->|—>|->|>)\s?|(?:→|➜|➔|»|-->|—>|->)\s)/;

  // Words that end a place name because they begin something else — a date, most often,
  // which is what follows the route on every ticket in the corpus.
  const STOP = /^(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

  const placeWords = (words, fromEnd) => {
    const taken = [];
    const ordered = fromEnd ? [...words].reverse() : words;

    for (const word of ordered) {
      // A place name is letters. Anything with a digit, or a trailing comma, ends it.
      if (!/^[A-Za-z][A-Za-z.'()-]*,?$/.test(word)) break;
      if (STOP.test(word)) break;

      /*
       * OCR debris from an icon beside the route.
       *
       * A goibibo ticket sets a small pictogram before the journey, which Tesseract reads
       * as "fa)" — a short run of letters with a stray bracket. Read right-to-left from
       * the arrow it is the *last* thing taken, so the origin came out "fa) Jaipur".
       *
       * A fragment carrying a bracket it never opened is not a word. Stopping rather
       * than skipping is deliberate: everything beyond the debris belongs to whatever
       * sits left of the icon, not to the route.
       */
      if (/[()]/.test(word) && !/^\([A-Za-z]+\)$/.test(word)) break;

      taken.push(word.replace(/,$/, ''));
      if (word.endsWith(',')) break;
      if (taken.length === 3) break;
    }

    return (fromEnd ? taken.reverse() : taken).join(' ').trim();
  };

  for (const line of top) {
    const arrow = ARROW.test(line.text);

    /*
     * A bare "to" needs the size test; an arrow does not, since nothing but a route is
     * written with one.
     *
     * The threshold is measured, not chosen. On an AbhiBus ticket the heading "Bangalore
     * to Pune" is set at 68 while the masthead above it — the operator's own logo — is
     * 108, so requiring four-fifths of the tallest line refused the very line being
     * looked for. A masthead is not a heading and should not set the bar.
     *
     * Half the tallest and a quarter again the body text is what separates a heading from
     * a sentence without letting the logo dictate. Both bounds are needed: the tallest
     * alone lets body text through on a page with no masthead, and the median alone lets
     * a large block of prose through on a page that is mostly headings.
     */
    const spelled = !arrow
      && (line.height || 0) >= Math.max(tallest * 0.45, median * 1.25)
      && /\sto\s/i.test(line.text);

    if (!arrow && !spelled) {
      /*
       * The third form: two place names side by side, with nothing between them but a
       * column gap where the arrow was drawn as a graphic.
       *
       * Paytm sets "Bengaluru    Proddatur    20-07-2017" and "DUNGARPUR    UDAIPUR" as
       * separate columns. The arrow between them is an image, so OCR returns no
       * connecting character at all and both the arrow and the "to" tests miss — which
       * is why those two tickets had no route whatsoever.
       *
       * Only admitted under the heading size test, and only when the first two columns
       * are both bare place names. Without that this would read any two-column row on
       * the page — an operator beside a bus type, a landmark beside a counter number.
       */
      if ((line.height || 0) < Math.max(tallest * 0.45, median * 1.25)) continue;

      const cells = splitColumns(line);
      if (cells.length < 2) continue;

      const place = /^[A-Za-z][A-Za-z .'-]{2,24}$/;
      const first = cells[0].text.trim();
      const second = cells[1].text.trim();
      if (!place.test(first) || !place.test(second)) continue;
      if (first.toUpperCase() === second.toUpperCase()) continue;

      // Not a caption pair. "Ticket ID | Order ID" is two columns of words at a heading
      // size on a Paytm slip, and reads as a route to anything checking only shape.
      if (CAPTION_ISH.test(first) || CAPTION_ISH.test(second)) continue;

      return { from: first, to: second, region: line };
    }

    const [left, right] = arrow ? line.text.split(ARROW) : line.text.split(/\s+to\s+/i);
    if (!left || !right) continue;

    const from = placeWords(left.trim().split(/\s+/), true);
    const to = placeWords(right.trim().split(/\s+/), false);

    if (!from || !to) continue;
    if (from.length < 3 || to.length < 3) continue;
    if (from.toUpperCase() === to.toUpperCase()) continue;

    return { from, to, region: line };
  }

  return null;
}

function buildTimes(draft, lines, mode) {
  const dateFound = findLabelled(lines, [
    /\b(?:date\s*of\s*(?:journey|travel|departure)|journey\s*date|travel\s*date|departure\s*date|doj)\b/i,
    /\bdate\b/i,
  ]);
  let parsed = dateFound ? parseDate(dateFound.value) : null;
  let dateRegion = dateFound?.region || null;

  /*
   * The heading again, which is where a bus ticket puts its date.
   *
   * No bus ticket in the corpus labels the day. Every one of them prints it beside the
   * journey — "Guwahati > Duliajan  Thursday, October 3, 2019", "Bangalore to Pune
   * 02-01-2014", "Bengaluru  Proddatur  20-07-2017" — and the Date field came out blank
   * on all four as a result.
   *
   * Only from the line the route was read from, or the two beneath it — Paytm sets the
   * date on its own line directly under the two place names. Scanning the whole page for
   * any date would find the booking date, the print stamp and the offer expiry, and a
   * pass dated to when it was bought is worse than one with no date, because nobody
   * checks a field that looks filled in.
   */
  if (draft.headingLine) {
    const index = lines.indexOf(draft.headingLine);
    const nearby = index >= 0 ? lines.slice(index, index + 5) : [draft.headingLine];

    for (const line of nearby) {
      const fromHeading = parseDate(line.text);
      if (!fromHeading?.date) continue;

      /*
       * A dated heading beats an undated label.
       *
       * A goibibo ticket carries a labelled date with no year, which falls back to the
       * current year — so a journey in August 2022 was dated August 2026. Its heading
       * says "Wednesday, August 10th, 2022" in full. A year that was read always beats a
       * year that was assumed, whatever the labels say.
       */
      if (!parsed?.date || (fromHeading.hadYear && !parsed.hadYear)) {
        parsed = fromHeading;
        dateRegion = line;
      }
      break;
    }
  }

  const dateField = draft.set('date', new Field({
    key: 'date',
    label: 'Date',
    value: parsed?.date ? parsed.date.toISOString().slice(0, 10) : '',
    source: (dateFound || parsed) ? Source.PDF_TEXT : Source.INFERRED,
    type: 'date',
    region: dateRegion,
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

  /*
   * An unparsed value is only worth keeping if it could be a seat at all.
   *
   * Where parsing fails the raw text was printed regardless, so an AbhiBus header row
   * "Travellers | Age | Seat | Details" put "Details" on the pass as the seat, and a
   * goibibo row put "Departure time" there. Both are the caption beside the one that
   * matched — furniture, not an allocation.
   *
   * A seat, berth or screen position always carries a digit somewhere: 35, S3, 18E,
   * C4-17. A value with none is not one, and a blank the user is asked to fill is far
   * better than a word that looks filled in.
   */
  const fallback = firstColumn(raw, 24);
  const usableFallback = /\d/.test(fallback) ? fallback : '';

  const seatField = draft.set('seat', new Field({
    key: 'seat',
    label: multiple ? vocab.seatLabelPlural : vocab.seatLabel,
    value: parsed?.summary || parsed?.display || coachBerth?.number || usableFallback,
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
      label: 'Berth',
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
    name: /^#?\s*(?:s\s*no\.?\s*)?name\b/i,
    age: /\bage\b/i,
    // "Sex" as well as "Gender": IRCTC prints the former, and a heading the reader does
    // not recognise is one fewer column towards the minimum needed to call something a
    // table at all — which is how a real passenger table went unread.
    gender: /\b(?:gender|sex)\b/i,
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

  // Anything that is plainly not a person.
  //
  // The table ends where the ticket's small print begins, and a heading such as
  // "Acronyms:" sits close enough to be mistaken for one more row. A name does not end
  // in a colon, is not a sentence, and is not a currency amount.
  table.rows = table.rows.filter((row) => {
    const name = (row.name || '').trim();
    if (!name) return false;
    if (/[:；;]$/.test(name)) return false;
    if (name.split(/\s+/).length > 5) return false;
    if (/\d{4,}|₹|rs\.?\s*\d|%|\bfee\b|\bfare\b|\bcharges?\b|\btotal\b|\bdetails?\b/i.test(name)) return false;
    return /[A-Za-z]{2,}/.test(name);
  });

  return table.rows.length ? table : null;
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
      key: 'seat', label: 'Seat', value: berth, source: Source.PDF_TEXT, critical: true,
    }));
  }

  if (parsed?.positionName && !draft.value('berthPosition')) {
    draft.set('berthPosition', new Field({
      key: 'berthPosition', label: 'Berth', value: parsed.positionName, source: Source.PDF_TEXT,
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

  /*
   * The prose fallback scans the whole document, which includes column headings and body
   * text. Two words in that list are dangerous enough to need their own rule.
   *
   * "WL" — the IRCTC email heads its berth column "Seat / Berth / WL No", and reading a
   * status from it would tell a confirmed passenger they are waitlisted. A bare WL is
   * only a status when a number follows it.
   *
   * "CAN" — worse, because it is three letters that occur inside ordinary words and on
   * this very ticket: "Ambala Cant Jn" is the boarding station, and OCR reading a
   * printed page does not always keep "Cant" in one piece. A confirmed passenger was
   * shown a status of CAN, which anyone would read as cancelled — the single most
   * alarming thing this app could get wrong. Cancellation is now recognised only from
   * the whole word, which no station name contains.
   */
  const prose = text
    .replace(/\b(?:seat|berth|coach)\s*\/[^\n]*/gi, ' ')
    .match(/\b(CNF|CONFIRMED|RAC\s*\d*|WL\s*\d+|WAITLIST(?:ED)?|CANCELLED|CANCELED|TQWL\s*\d*|PQWL\s*\d*|RLWL\s*\d*|GNWL\s*\d*)\b/i);

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
