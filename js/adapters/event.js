/**
 * Event adapter — cinema, concert, theatre, sport, conference.
 *
 * Unlike a boarding pass there is no standard here. No IATA equivalent exists for a
 * cinema stub: the barcode is usually an opaque booking reference the venue's own
 * scanner resolves against its database, so it tells us almost nothing about the
 * event. Everything meaningful must be read from the printed text.
 *
 * That inverts the flight adapter's economics. There we had ground truth and used text
 * to corroborate; here text is all we have, so the job is to be *careful* rather than
 * confident — recognising the shapes cinema and ticketing platforms actually print,
 * and declining to guess when the shape is unfamiliar.
 *
 * The reward for the effort is that `eventTicket` is by far the richest Wallet style:
 * a full-width strip image, a venue location that triggers lock-screen relevance, and
 * an event type Apple uses to pick its own iconography.
 */

import {
  register, Field, Source, Confidence, TicketDraft,
  parseTime, parseDate, findLabelled, findProvider, toPlainText,
} from './registry.js';

// ────────────────────────────── detection ──────────────────────────────

/**
 * Vocabulary that distinguishes an event ticket, weighted by how much each word
 * actually proves. "Screen" and "auditorium" are near-conclusive for cinema; "ticket"
 * appears on almost everything and is therefore worth very little.
 */
const SIGNALS = [
  [/\b(?:cinema|cineplex|multiplex|movies?|film)\b/i, 22, 'movie'],
  [/\bscreen\s*(?:no\.?|number)?\s*\d+\b|\bauditorium\b|\bhall\s*\d+\b/i, 26, 'movie'],
  [/\b(?:showtime|show\s*time|screening|now\s*showing)\b/i, 24, 'movie'],
  [/\b(?:rated|certificate)\s*[:\s]*(?:U\/A|UA|PG-?13|PG|R|G|NC-?17|12A?|15|18)\b/i, 18, 'movie'],
  [/\b(?:2D|3D|IMAX|4DX|DOLBY\s*CINEMA|ATMOS|RECLINER)\b/, 12, 'movie'],
  [/\b(?:concert|tour|live\s*in\s*concert|gig)\b/i, 20, 'concert'],
  [/\b(?:stadium|arena|amphitheat(?:re|er))\b/i, 14, 'concert'],
  [/\b(?:theatre|theater|playhouse|opera|ballet)\b/i, 18, 'theatre'],
  [/\b(?:match|fixture|kick-?off|vs\.?|versus)\b/i, 16, 'sport'],
  [/\b(?:conference|summit|expo|keynote|badge|delegate)\b/i, 18, 'conference'],
  [/\b(?:row|seat)\s*[:\s]*[A-Z]{1,2}\s*-?\s*\d{1,3}\b/i, 16, null],
  [/\b(?:box\s*office|admit\s*one|e-?ticket|booking\s*(?:id|ref))\b/i, 10, null],
  [/\bdoors?\s*(?:open|at)\b/i, 14, null],
  [/\b(?:venue|location)\b/i, 8, null],
];

/** Things that mean this is emphatically not an event ticket. */
const DISQUALIFIERS = /\b(?:boarding\s*pass|gate\s*close|baggage|check-?in\s*counter|PNR|flight\s*no)\b/i;

function detect(context) {
  // A BCBP payload is definitive proof of a boarding pass. Never compete with that.
  if (/^M[1-9]/.test(context.barcode?.text || '')) return 0;

  const text = toPlainText(context.lines);
  if (DISQUALIFIERS.test(text)) return 0;

  let score = 0;
  const categories = new Map();

  for (const [pattern, weight, category] of SIGNALS) {
    if (!pattern.test(text)) continue;
    score += weight;
    if (category) categories.set(category, (categories.get(category) || 0) + weight);
  }

  // A date and a time together is weak evidence alone, but it is the minimum an event
  // ticket must have; without both, whatever this is cannot be scheduled.
  if (parseDate(text) && /\b\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?\b/i.test(text)) score += 10;

  return score >= 34 ? Math.min(score, 95) : 0;
}

/** The strongest category signal decides which artwork and Wallet event type we use. */
function classify(text) {
  const scores = new Map();
  for (const [pattern, weight, category] of SIGNALS) {
    if (category && pattern.test(text)) {
      scores.set(category, (scores.get(category) || 0) + weight);
    }
  }
  if (!scores.size) return { category: 'event', confidence: Confidence.LOW };

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [category, top] = ranked[0];
  const runnerUp = ranked[1]?.[1] || 0;

  // A clear winner is trustworthy; a near-tie means the ticket is genuinely ambiguous
  // and the user should be offered the choice.
  return {
    category,
    confidence: top >= 30 && top > runnerUp * 1.6 ? Confidence.HIGH : Confidence.MEDIUM,
  };
}

/**
 * Apple's own event types. Setting the right one lets Wallet choose its iconography
 * and phrasing, which is a large part of why these passes look native rather than
 * home-made.
 */
const EVENT_TYPE = {
  movie: 'PKEventTypeMovie',
  concert: 'PKEventTypeLivePerformance',
  theatre: 'PKEventTypeLivePerformance',
  sport: 'PKEventTypeSports',
  conference: 'PKEventTypeConference',
  event: 'PKEventTypeGeneric',
};

const CATEGORY_LABEL = {
  movie: 'Film', concert: 'Concert', theatre: 'Show',
  sport: 'Match', conference: 'Conference', event: 'Event',
};

// ────────────────────────────── seats ──────────────────────────────

/**
 * Parses the many ways venues print seating.
 *
 * Cinemas in particular issue one PDF covering several seats — "A5, A6, A7" or
 * "G12-G14" — and the count matters, because a pass that admits two when four people
 * are waiting outside is a real problem at the door. Ranges are expanded so the number
 * of seats is explicit rather than implied.
 */
export function parseSeats(raw) {
  if (!raw) return null;
  const text = String(raw).toUpperCase().replace(/\s*[–—]\s*/g, '-').trim();

  const seats = [];
  let expandedRange = false;
  let lastRow = null;

  // Each comma- or slash-separated segment is parsed independently.
  //
  // This must not short-circuit on the first range it finds: a single booking can mix
  // runs and singletons across different rows — "G1-G9, C1-C3" is an ordinary family
  // booking — and handling only the first form would silently discard the rest. Seats
  // missing from a pass are discovered at the door, far too late to fix.
  for (const part of text.split(/[,;/|]+|\s{2,}/)) {
    const token = part.trim();
    if (!token) continue;

    // "G12-G14", "G12-14" or a bare "12-14" inheriting the previous row.
    const range = token.match(/^([A-Z]{1,2})?\s*-?\s*(\d{1,3})\s*-\s*([A-Z]{1,2})?\s*-?\s*(\d{1,3})$/);
    if (range) {
      const [, rowText, startText, endRowText, endText] = range;
      const row = rowText || lastRow || '';
      const endRow = endRowText || row;
      const start = parseInt(startText, 10);
      const end = parseInt(endText, 10);

      // Only expand within a single row. A cross-row range has no defined ordering —
      // we cannot know how many seats row G holds — so it is kept verbatim rather than
      // invented.
      if (endRow === row && end >= start && end - start < 40) {
        for (let n = start; n <= end; n++) seats.push(`${row}${n}`);
        if (end > start) expandedRange = true;
        if (rowText) lastRow = rowText;
        continue;
      }

      seats.push(token);
      continue;
    }

    // "A5" — an explicit row and number.
    const withRow = token.match(/^([A-Z]{1,2})\s*-?\s*(\d{1,3})$/);
    if (withRow) {
      lastRow = withRow[1];
      seats.push(`${withRow[1]}${withRow[2]}`);
      continue;
    }

    // A bare number inherits the last row seen, which is how "A5, 6, 7" is universally
    // meant.
    const bare = token.match(/^(\d{1,3})$/);
    if (bare && lastRow) seats.push(`${lastRow}${bare[1]}`);
    else if (bare) seats.push(bare[1]);
  }

  if (!seats.length) return null;

  const unique = [...new Set(seats)];
  return {
    seats: unique,
    count: unique.length,
    display: unique.join(', '),
    ...summariseSeats(unique),
    expandedRange,
  };
}

/**
 * Condenses a seat list to something that fits on the face of a pass.
 *
 * This exists because Wallet fields are narrow and unforgiving: a value too long for
 * its slot is shrunk until it is unreadable, then truncated mid-list — and a family of
 * six seeing "G12, G13, G1…" at the door has been actively misled about which seats
 * they hold.
 *
 * So contiguous runs collapse to ranges ("G12–G17"), which is both shorter and how
 * people actually say it. Beyond what a range can express, the front of the pass states
 * the count honestly and the full list moves to the back, where Wallet lets text wrap
 * and scroll freely. Nothing is ever silently dropped.
 */
export function summariseSeats(seats) {
  if (!seats?.length) return { summary: '', isSummarised: false };
  if (seats.length === 1) return { summary: seats[0], isSummarised: false };

  // Group by row, so runs can be detected within each.
  const rows = new Map();
  const unparsed = [];

  for (const seat of seats) {
    const match = String(seat).match(/^([A-Z]{0,2})(\d{1,3})$/i);
    if (!match) { unparsed.push(seat); continue; }
    const row = match[1].toUpperCase();
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(parseInt(match[2], 10));
  }

  if (!rows.size) {
    return { summary: seats.join(', '), isSummarised: false };
  }

  const parts = [];
  for (const [row, numbers] of rows) {
    numbers.sort((a, b) => a - b);

    let start = numbers[0];
    let previous = start;

    const flush = () => {
      // A two-seat "range" is longer written as a range than listed, so only collapse
      // runs of three or more.
      if (previous - start >= 2) parts.push(`${row}${start}–${row}${previous}`);
      else for (let n = start; n <= previous; n++) parts.push(`${row}${n}`);
    };

    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] === previous + 1) { previous = numbers[i]; continue; }
      flush();
      start = numbers[i];
      previous = start;
    }
    flush();
  }

  parts.push(...unparsed);
  const condensed = parts.join(', ');

  // Roughly what a primary field holds before Wallet starts shrinking it. Past that,
  // the count is more useful than a truncated list — it is at least true.
  const FRONT_LIMIT = 24;
  if (condensed.length <= FRONT_LIMIT) {
    return { summary: condensed, isSummarised: condensed !== seats.join(', ') };
  }

  return {
    summary: `${seats.length} seats`,
    isSummarised: true,
    condensed,
    overflowed: true,
  };
}

/**
 * Finds the venue.
 *
 * Deliberately conservative. A venue string is what Wallet may geocode for lock-screen
 * relevance, so a wrong one sends the user's phone looking for the wrong building —
 * and worse, stays silent when they actually arrive.
 */
function findVenue(lines) {
  const labelled = findLabelled(lines, [
    /\b(?:venue|location|cinema|theatre|theater|address|at)\b/i,
  ]);
  if (labelled?.value && labelled.value.length > 2) {
    return { ...labelled, confidence: Confidence.MEDIUM };
  }

  // Unlabelled fallback: a prominent line carrying a venue-ish word.
  const candidate = lines.find((line) =>
    /\b(?:cinemas?|cineplex|multiplex|theatre|theater|arena|stadium|hall|centre|center|pavilion|club)\b/i
      .test(line.text) && line.text.length < 70);

  if (!candidate) return null;
  return {
    value: candidate.text.trim(),
    region: { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height },
    confidence: Confidence.LOW,
  };
}

/**
 * Finds the event's title.
 *
 * Typography is the most reliable signal available: the film or artist name is nearly
 * always the largest text on the ticket that is not the venue's own branding. Label
 * matching is tried first because an explicit "Movie:" caption beats any heuristic.
 */
function findTitle(lines, { providerText = null } = {}) {
  const labelled = findLabelled(lines, [
    /\b(?:movie|film|event|show|performance|title|attraction)\s*(?:name|title)?\b/i,
  ]);
  if (labelled?.value && labelled.value.length > 1) {
    return { ...labelled, confidence: Confidence.MEDIUM };
  }

  const heights = lines.map((line) => line.height).filter(Boolean).sort((a, b) => a - b);
  if (!heights.length) return null;
  const typical = heights[Math.floor(heights.length / 2)];

  const candidates = lines.filter((line) => {
    const text = line.text.trim();
    if (!text || text.length < 2 || text.length > 60) return false;
    if (line.height < typical * 1.25) return false;
    if (providerText && text.toLowerCase() === providerText.toLowerCase()) return false;
    if (line.looksLikeLabel) return false;
    // Reject anything that reads as data rather than a name.
    if (/^\W+$/.test(text)) return false;
    if (/\d{4,}/.test(text)) return false;
    if (/\b(?:booking|order|ref|total|amount|paid|invoice|gst|tax)\b/i.test(text)) return false;
    return true;
  });

  if (!candidates.length) return null;

  // Largest text wins; ties break toward the top of the page.
  const best = candidates.sort((a, b) => b.height - a.height || a.y - b.y)[0];
  return {
    value: best.text.trim(),
    region: { x: best.x, y: best.y, width: best.width, height: best.height },
    confidence: Confidence.LOW,
  };
}

// ────────────────────────────── build ──────────────────────────────

async function build(context) {
  const { lines, barcode } = context;
  const text = toPlainText(lines);
  const { category, confidence: categoryConfidence } = classify(text);

  const draft = new TicketDraft({
    type: category === 'movie' ? 'movie' : 'event',
    style: 'eventTicket',
    adapter: 'event',
    confidence: categoryConfidence,
  });

  draft.barcode = barcode;
  draft.category = category;
  draft.eventType = EVENT_TYPE[category] || EVENT_TYPE.event;

  // ── Provider (pass header, per Apple's convention) ──
  const provider = findProvider(lines);
  draft.set('provider', new Field({
    key: 'provider',
    label: 'Booked with',
    value: provider?.value || '',
    source: provider?.value ? Source.PDF_TEXT : Source.INFERRED,
    confidence: provider?.confidence || Confidence.LOW,
    region: provider?.region || null,
  }));

  // ── Title ──
  const title = findTitle(lines, { providerText: provider?.value });
  const titleField = draft.set('title', new Field({
    key: 'title',
    label: CATEGORY_LABEL[category] || 'Event',
    value: title?.value || '',
    source: title ? Source.PDF_TEXT : Source.INFERRED,
    confidence: title?.confidence || Confidence.MISSING,
    region: title?.region || null,
    required: true,
  }));
  if (title?.confidence === Confidence.LOW) {
    titleField.note = 'Worked out from the largest text on your ticket — worth a glance.';
  }

  // ── Category, offered as a correctable choice ──
  const categoryField = draft.set('category', new Field({
    key: 'category',
    label: 'Type',
    value: category,
    source: Source.INFERRED,
    confidence: categoryConfidence,
    type: 'select',
    options: Object.keys(EVENT_TYPE),
  }));
  if (categoryConfidence !== Confidence.HIGH) {
    categoryField.note = 'Sets the artwork and the icon Wallet shows.';
  }

  // ── Venue ──
  const venue = findVenue(lines);
  const venueField = draft.set('venue', new Field({
    key: 'venue',
    label: 'Venue',
    value: venue?.value || '',
    source: venue ? Source.PDF_TEXT : Source.INFERRED,
    confidence: venue?.confidence || Confidence.MISSING,
    region: venue?.region || null,
    required: true,
  }));
  venueField.note = 'Wallet uses this to surface the pass when you arrive, so it is worth getting right.';

  // ── Screen or auditorium ──
  const screen = findLabelled(lines, [
    /\b(?:screen|audi(?:torium)?|hall|theatre\s*no|room)\s*(?:no\.?|number|#)?\b/i,
  ]);
  if (screen?.value) {
    draft.set('screen', new Field({
      key: 'screen',
      label: category === 'movie' ? 'Screen' : 'Hall',
      value: screen.value.split(/\s{2,}/)[0].slice(0, 20),
      source: Source.PDF_TEXT,
      region: screen.region,
    }));
  }

  // ── Seats ──
  const seatText = findLabelled(lines, [/\bseats?\s*(?:no\.?|numbers?)?\b/i]);
  const parsedSeats = parseSeats(seatText?.value);

  const seatField = draft.set('seat', new Field({
    key: 'seat',
    label: parsedSeats?.count > 1 ? 'Seats' : 'Seat',
    value: parsedSeats?.display || seatText?.value?.trim() || '',
    source: seatText ? Source.PDF_TEXT : Source.INFERRED,
    region: seatText?.region || null,
  }));

  if (seatText && !parsedSeats) {
    seatField.warn(`We could not make sense of "${seatText.value}" as seat numbers.`, 'unparsed-seat');
  }
  if (parsedSeats?.expandedRange) {
    seatField.note = `Expanded from a range — ${parsedSeats.count} seats.`;
  }

  // ── Admission count ──
  // Wallet has no admit-count field, so this goes on the back of the pass. It matters:
  // whoever is on the door needs to know how many people this one barcode covers.
  const printedQuantity = findLabelled(lines, [
    /\b(?:tickets?|qty|quantity|no\.?\s*of\s*(?:tickets?|persons?)|admits?)\b/i,
  ]);
  const quantityFromText = printedQuantity?.value?.match(/\b(\d{1,2})\b/);
  const admits = parsedSeats?.count || (quantityFromText ? parseInt(quantityFromText[1], 10) : null);

  if (admits) {
    const admitField = draft.set('admits', new Field({
      key: 'admits',
      label: 'Admits',
      value: String(admits),
      source: parsedSeats ? Source.INFERRED : Source.PDF_TEXT,
      confidence: parsedSeats ? Confidence.MEDIUM : Confidence.MEDIUM,
      region: printedQuantity?.region || null,
      type: 'number',
    }));

    // Two independent statements of the same number is real corroboration.
    if (parsedSeats && quantityFromText) {
      const printed = parseInt(quantityFromText[1], 10);
      if (printed === parsedSeats.count) admitField.corroborate(Source.PDF_TEXT);
      else admitField.conflict(String(printed), Source.PDF_TEXT);
    }
  }

  // ── Date and time ──
  buildWhen(draft, lines, text);

  // ── Booking reference ──
  const booking = findLabelled(lines, [
    /\b(?:booking\s*(?:id|ref\w*|code|no\.?|number)|order\s*(?:id|no\.?|number)|confirmation\s*(?:code|number)|reference)\b/i,
  ]);
  if (booking?.value) {
    draft.set('booking', new Field({
      key: 'booking',
      label: 'Booking ref',
      value: booking.value.split(/\s{2,}/)[0].slice(0, 24),
      source: Source.PDF_TEXT,
      region: booking.region,
    }));
  }

  // ── Certification, for films ──
  if (category === 'movie') {
    const rating = text.match(/\b(?:rated|certificate)\s*[:\s]*((?:U\/A|UA|PG-?13|PG|NC-?17|[UAGR]|12A?|15|18)\b[\w+]*)/i);
    if (rating) {
      draft.set('rating', new Field({
        key: 'rating', label: 'Certificate', value: rating[1].toUpperCase(), source: Source.PDF_TEXT,
      }));
    }

    const format = text.match(/\b(IMAX(?:\s*3D)?|4DX|DOLBY\s*CINEMA|DOLBY\s*ATMOS|3D|2D)\b/i);
    if (format) {
      draft.set('format', new Field({
        key: 'format', label: 'Format', value: format[1].toUpperCase(), source: Source.PDF_TEXT,
      }));
    }
  }

  if (!barcode) {
    draft.warnings.push(
      'No barcode was found on this ticket. Wallet can still hold the pass, but the venue ' +
      'will not be able to scan it, so bring the original as well.'
    );
  }

  return draft;
}

/**
 * Establishes when the event happens.
 *
 * The single most consequential pair of fields on the pass: `relevantDate` is what
 * makes it appear on the lock screen at the right moment, which is the entire reason
 * for using Wallet instead of a screenshot. A wrong time here doesn't merely look
 * untidy — it silently fails to do the one job the user wanted.
 */
function buildWhen(draft, lines, text) {
  const printedDate = findLabelled(lines, [
    /\b(?:date|show\s*date|event\s*date|on)\b/i,
  ]);

  let parsed = printedDate ? parseDate(printedDate.value) : null;
  let source = Source.PDF_TEXT;
  let region = printedDate?.region || null;

  // Fall back to scanning the whole document, which is weaker: a ticket also prints a
  // booking date, and picking that would put the pass on the wrong day entirely.
  if (!parsed?.date) {
    const loose = parseDate(text);
    if (loose?.date) {
      parsed = loose;
      region = null;
      source = Source.INFERRED;
    }
  }

  const dateField = draft.set('date', new Field({
    key: 'date',
    label: 'Date',
    value: parsed?.date ? parsed.date.toISOString().slice(0, 10) : '',
    source: parsed?.date ? source : Source.INFERRED,
    confidence: parsed?.date
      ? (source === Source.PDF_TEXT ? Confidence.MEDIUM : Confidence.LOW)
      : Confidence.MISSING,
    type: 'date',
    required: true,
    region,
  }));

  if (parsed?.ambiguous) {
    dateField.warn(
      'The date is printed in a form that could be read two ways, so we have not guessed. Please set it.',
      'ambiguous-date',
    );
  }
  if (source === Source.INFERRED && parsed?.date) {
    dateField.note = 'Found elsewhere on the ticket — check this is the show date, not the booking date.';
  }
  if (parsed?.date && !parsed.hadYear) {
    dateField.warn('No year was printed, so the current one was assumed.', 'assumed-year');
  }

  const printedTime = findLabelled(lines, [
    /\b(?:time|show\s*time|showtime|start(?:s|ing)?|doors?\s*open)\b/i,
  ]);
  let time = printedTime ? parseTime(printedTime.value) : null;
  let timeRegion = printedTime?.region || null;

  if (!time) {
    const loose = text.match(/\b\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?\b/i);
    if (loose) {
      time = parseTime(loose[0]);
      timeRegion = null;
    }
  }

  const timeField = draft.set('time', new Field({
    key: 'time',
    label: 'Starts',
    value: time?.text || '',
    source: printedTime && time ? Source.PDF_TEXT : Source.INFERRED,
    confidence: time ? (printedTime ? Confidence.MEDIUM : Confidence.LOW) : Confidence.MISSING,
    type: 'time',
    required: true,
    region: timeRegion,
  }));

  // A 7:30 with no am/pm marker is the classic way to send someone twelve hours early.
  if (time && !time.hadMeridiem && time.hours < 12 && time.hours >= 1) {
    timeField.warn(
      'This is printed without am or pm. Evening showings are common, so please confirm.',
      'ambiguous-meridiem',
    );
  }

  // Times are local to the venue, and Wallet is told to display them exactly as
  // printed rather than converting to the phone's zone. No venue time zone lookup
  // exists, so honouring the printed wall-clock is the only correct behaviour.
  timeField.ignoresTimeZone = true;

  return { dateField, timeField };
}

export const eventAdapter = register({
  name: 'event',
  detect,
  build,
});

export { detect, build, classify, findTitle, findVenue };
