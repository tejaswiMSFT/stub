/**
 * Lodging adapter — hotels, resorts, homestays, and railway retiring rooms.
 *
 * A stay is not a journey, and forcing it into the journey shape was the reason
 * `rail.js` declines retiring rooms outright: a hotel has no origin and no destination,
 * and inventing them would put two invented stations on the face of a pass.
 *
 * What a stay has instead is a *place* and a *window* — where you are staying, from
 * when until when. Check-in and check-out are the fields someone is actually asked for
 * at a front desk, together with the booking reference and the lead guest's name.
 *
 * The care here goes into what this adapter *refuses*. Travel agents issue a voucher
 * and an invoice for the same stay, and both carry the hotel's name, its city, and the
 * check-in and check-out dates. Only the voucher gets you a room. The invoice is an
 * accounting document — MakeMyTrip prints "This is not a valid travel document" on its
 * own — and turning one into something that looks like a booking confirmation would be
 * actively misleading at a reception desk.
 */

import {
  register, Field, Source, Confidence, TicketDraft,
  parseTime, parseDate, findLabelled, findProvider, toPlainText,
} from './registry.js';
import { splitColumns } from '../text.js';

// ────────────────────────────── detection ──────────────────────────────

/**
 * Documents about a stay that do not entitle anyone to one.
 *
 * Checked before anything else and answered with a flat refusal, because these score
 * well on every positive signal — they are, after all, about a real hotel booking.
 */
const NOT_A_BOOKING = [
  /\btax\s*invoice\b/i,
  /\bthis\s+is\s+not\s+a\s+valid\s+travel\s+document\b/i,
  /\b(?:credit|debit)\s*note\b/i,
  /\bproforma\b/i,
  /\bcancellation\s+(?:invoice|receipt|confirmation)\b/i,
  /\brefund\s+(?:receipt|advice)\b/i,
];

const SIGNALS = [
  // Near-conclusive: the pair of them is what a stay *is*.
  [/\bcheck[\s-]?in\b/i, 24],
  [/\bcheck[\s-]?out\b/i, 24],
  [/\b\d+\s*[-\s]?nights?\s*(?:stay)?\b/i, 22],
  [/\b(?:hotel|resort|inn|lodge|guest\s*house|homestay|hostel|villa|apartment)\b/i, 18],
  [/\bretiring\s*room\b|\bdormitory\b/i, 22],
  [/\b(?:room\s*type|standard\s*room|deluxe|suite|twin|double|single)\s*(?:room)?\b/i, 12],
  [/\b(?:primary\s*guest|lead\s*guest|guest\s*name)\b/i, 20],
  [/\b\d+\s*guests?\b|\b\d+\s*adults?\b/i, 10],
  [/\bbooking\s*voucher\b|\bhotel\s*voucher\b|\baccommodation\b/i, 20],
  [/\b(?:property|reception|front\s*desk)\b/i, 8],
];

function detect(context) {
  const text = toPlainText(context.lines || []);
  if (!text.trim()) return 0;

  for (const pattern of NOT_A_BOOKING) {
    if (pattern.test(text)) return 0;
  }

  let score = 0;
  for (const [pattern, weight] of SIGNALS) {
    if (pattern.test(text)) score += weight;
  }

  // Both halves of the window, or it is something else that merely mentions a hotel —
  // a receipt for a taxi to one, say.
  const hasWindow = /\bcheck[\s-]?in\b/i.test(text) && /\bcheck[\s-]?out\b/i.test(text);
  if (!hasWindow && !/\bretiring\s*room\b/i.test(text)) score = Math.min(score, 30);

  return score >= 55 ? Math.min(score, 95) : 0;
}

// ────────────────────────────── extraction ──────────────────────────────

/**
 * Reads a date and, where printed, the time beneath it.
 *
 * Hotels state both but rarely on one line: "Mon, 22 May 2023" sits above "After 01:30
 * PM", and check-in and check-out sit side by side as two columns of the same block. The
 * time must therefore be read from the label's *own column*, or check-out inherits
 * check-in's time — the first one found on a shared line.
 *
 * The qualifier is kept as a note rather than folded into the time. Arriving before
 * check-in opens is the commonest way a guest is turned away at a desk, but "After 01:30
 * PM" is not a time; it is a promise about one.
 */
function readMoment(lines, patterns) {
  const found = findLabelled(lines, patterns);
  if (!found) return null;

  const parsed = parseDate(found.value);

  let time = parseTime(found.value);
  let qualifier = found.value.match(/\b(after|before|from|until|till)\b/i)?.[1] || null;

  const column = found.region?.x;
  const index = found.line ? lines.indexOf(found.line) : -1;

  if (!time && index >= 0) {
    for (let next = index + 1; next < Math.min(index + 4, lines.length); next++) {
      // Only the cell sitting under this label, so the neighbouring column's time is
      // never mistaken for this one's.
      const cells = splitColumns(lines[next]);
      const beneath = column === undefined
        ? cells[0]
        : cells.find((cell) => Math.abs(cell.x - column) <= Math.max(cell.width, 24));

      const nearby = beneath && parseTime(beneath.text);
      if (nearby) {
        time = nearby;
        qualifier = beneath.text.match(/\b(after|before|from|until|till)\b/i)?.[1] || qualifier;
        break;
      }
    }
  }

  return { found, parsed, time, qualifier };
}

function addMoment(draft, key, label, moment) {
  const field = draft.set(key, new Field({
    key,
    label,
    // Plain YYYY-MM-DD, matching every other adapter. A full Wallet timestamp here was
    // shown to the user verbatim — "2023-05-22T00:00:00Z" on the face of the pass — and
    // denied the review screen its date picker.
    value: moment?.parsed?.date ? moment.parsed.date.toISOString().slice(0, 10) : '',
    type: 'date',
    source: moment?.found ? Source.PDF_TEXT : Source.INFERRED,
    confidence: moment?.parsed?.date ? Confidence.MEDIUM : Confidence.LOW,
    region: moment?.found?.region || null,
    required: true,
    critical: true,
  }));

  if (moment?.parsed?.ambiguous) {
    field.confidence = Confidence.LOW;
    field.warn(
      `"${moment.found.value.trim()}" could be either day-month or month-day. Please pick the right one.`,
      'ambiguous-date',
    );
  }

  if (moment?.time) {
    const timeField = draft.set(`${key}Time`, new Field({
      key: `${key}Time`,
      label: `${label} time`,
      value: moment.time.text,
      type: 'time',
      source: Source.PDF_TEXT,
      confidence: Confidence.MEDIUM,
    }));

    // "After 01:30 PM" is a rule about the earliest arrival, not the arrival itself.
    if (moment.qualifier) {
      timeField.note = `${moment.qualifier[0].toUpperCase()}${moment.qualifier.slice(1).toLowerCase()} `
        + `${moment.time.text}`;
    }
  }

  return field;
}

/** The property's name: the largest thing on the page that is not the agent's brand. */
function findPropertyName(lines, provider) {
  const labelled = findLabelled(lines, [
    /\b(?:hotel|property|resort)\s*name\b/i,
    /\bproperty\b(?!\s*allows)/i,
  ]);
  if (labelled?.value) return { value: labelled.value.split(/\s{2,}/)[0].trim(), region: labelled.region };

  // Otherwise the prominent line, provided it is not the booking agent's own name —
  // "MakeMyTrip" is set larger than the hotel on its own voucher.
  const prominent = findProvider(lines);
  if (prominent?.value && prominent.value !== provider) {
    return { value: prominent.value, region: prominent.region };
  }

  return null;
}

/**
 * Reads a name that precedes its own label.
 *
 * "Mr. Sample R (Primary Guest)" states who the guest is *before* saying so, which
 * inverts every label search in the codebase — those look to the right of a caption, and
 * to the right of this one is nothing. pdf.js may also split the two apart, so the
 * preceding cell is considered as well as the same one.
 */
function guestBeforeLabel(lines) {
  const LABEL = /\((?:primary|lead)\s*guest\)|\b(?:primary|lead)\s*guest\b/i;

  for (const line of lines) {
    const cells = splitColumns(line);

    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index].text;
      if (!LABEL.test(cell)) continue;

      const before = cell.replace(LABEL, ' ').trim()
        || (index > 0 ? cells[index - 1].text.trim() : '');

      // Strip the honorific but keep the name as printed; a hotel writes it in mixed
      // case and reprinting it shouted would look like a different document.
      const name = before.replace(/^(mr|mrs|ms|miss|mstr|master|dr|prof)\.?\s+/i, '').trim();
      if (name && /[A-Za-z]{2,}/.test(name) && name.length <= 60) return name;
    }
  }

  return null;
}

/**
 * Finds the property's own telephone number.
 *
 * The agent's support line and the guest's own mobile are both on the page, and neither
 * is useful to someone standing outside the hotel. Numbers already used as a booking
 * reference are excluded outright, and a line naming the agent is skipped.
 */
function findPropertyPhone(lines, claimed) {
  const AGENT_LINE = /\b(?:makemytrip|goibibo|support|helpline|customer\s*care|toll[\s-]?free)\b/i;

  let fallback = null;

  for (const line of lines) {
    if (AGENT_LINE.test(line.text)) continue;

    const bare = /^\+?[\d\s-]{8,18}$/.test(line.text.trim());

    for (const match of line.text.matchAll(/\+?\d[\d\s-]{7,14}\d/g)) {
      const value = match[0].trim();
      const digits = value.replace(/\D/g, '');

      if (claimed.has(value) || claimed.has(digits)) continue;
      if (digits.length < 8 || digits.length > 13) continue;

      // A number on a line of its own is the property's contact block. The guest's own
      // mobile is printed beside their email address — "someone@example.com,
      // 919000000000" — and returning that would give a guest their own number at the
      // moment they were trying to telephone the hotel.
      if (bare) return value;

      if (/\breservation|\bhotel\b|\bproperty\b|\bresort\b|\bfront\s*desk\b/i.test(line.text)) {
        fallback ??= value;
      }
    }
  }

  return fallback;
}

function build(context) {
  const { lines = [], barcode } = context;
  const text = toPlainText(lines);

  const draft = new TicketDraft({
    type: 'lodging',
    style: 'generic',
    adapter: 'lodging',
    confidence: Confidence.MEDIUM,
  });

  // ── Who the booking is with ──
  const agent = text.match(/\b(MakeMyTrip|Goibibo|Booking\.com|Agoda|Expedia|Airbnb|Yatra|Cleartrip|OYO|Trivago|Hotels\.com|IRCTC)\b/i)?.[1];

  const property = findPropertyName(lines, agent);
  draft.set('property', new Field({
    key: 'property',
    label: 'Property',
    value: property?.value || '',
    source: property ? Source.PDF_TEXT : Source.INFERRED,
    confidence: property ? Confidence.MEDIUM : Confidence.LOW,
    region: property?.region || null,
    required: true,
    critical: true,
  }));

  draft.set('provider', new Field({
    key: 'provider',
    label: 'Booked via',
    value: agent || '',
    source: agent ? Source.PDF_TEXT : Source.INFERRED,
    confidence: Confidence.MEDIUM,
  }));

  // ── The window ──
  //
  // Both halves are critical. A guest who has the wrong check-out date discovers it at
  // the least convenient possible moment.
  addMoment(draft, 'checkIn', 'Check-in', readMoment(lines, [/\bcheck[\s-]?in\b/i]));
  addMoment(draft, 'checkOut', 'Check-out', readMoment(lines, [/\bcheck[\s-]?out\b/i]));

  const nights = text.match(/\b(\d+)\s*[-\s]?nights?\b/i);
  if (nights) {
    draft.set('nights', new Field({
      key: 'nights',
      label: 'Nights',
      value: nights[1],
      source: Source.PDF_TEXT,
      confidence: Confidence.MEDIUM,
    }));
  }

  // ── Reference ──
  //
  // Hotels quote the agent's booking ID, so it is preferred over a PNR where a document
  // carries both.
  const booking = findLabelled(lines, [
    /\bbooking\s*(?:id|ref\w*|number|code)\b/i,
    /\bconfirmation\s*(?:number|code)\b/i,
    /\bvoucher\s*(?:no\.?|number)\b/i,
  ]);
  const pnr = findLabelled(lines, [/\bPNR\b/i]);

  const referenceField = draft.set('reference', new Field({
    key: 'reference',
    label: 'Booking ID',
    value: booking?.value?.split(/\s{2,}/)[0]?.replace(/^:\s*/, '').trim()
      || pnr?.value?.split(/\s{2,}/)[0]?.trim() || '',
    source: (booking || pnr) ? Source.PDF_TEXT : Source.INFERRED,
    confidence: Confidence.MEDIUM,
    region: booking?.region || pnr?.region || null,
    required: true,
    critical: true,
  }));

  // Where both exist the second is kept too: some properties look up a stay by one and
  // some by the other, and a guest at a desk cannot know which in advance.
  if (booking && pnr) {
    draft.set('pnr', new Field({
      key: 'pnr',
      label: 'PNR',
      value: pnr.value.split(/\s{2,}/)[0].trim(),
      source: Source.PDF_TEXT,
      confidence: Confidence.MEDIUM,
      region: pnr.region,
    }));
  }

  if (!referenceField.value) {
    referenceField.warn('We could not find a booking reference — please add it.', 'missing-reference');
  }

  // ── Guest ──
  //
  // A voucher writes "Mr. Sample R (Primary Guest)" — the label comes *after* the name,
  // which no label search handles: looking to the right of "(Primary Guest)" finds
  // nothing at all. So the cell carrying the label is read directly and the label
  // removed from it, leaving the name.
  const guest = findLabelled(lines, [
    /\bguest\s*name\b/i,
    /\bcustomer\s*name\b/i,
    /\bname\s*of\s*guest\b/i,
    /\b(?:primary|lead)\s*guest\b/i,
  ]);

  const trailing = guestBeforeLabel(lines);

  const guestName = trailing
    || guest?.value?.replace(/\((?:primary|lead)\s*guest\)/i, '').split(/\s{2,}/)[0].trim();

  draft.set('guest', new Field({
    key: 'guest',
    label: 'Guest',
    value: guestName || '',
    source: (trailing || guest) ? Source.PDF_TEXT : Source.INFERRED,
    confidence: (trailing || guest) ? Confidence.MEDIUM : Confidence.LOW,
    region: guest?.region || null,
    required: true,
    critical: true,
  }));

  const partySize = text.match(/\b(\d+)\s*guests?\b/i) || text.match(/\b(\d+)\s*adults?\b/i);
  if (partySize) {
    draft.set('party', new Field({
      key: 'party',
      label: 'Guests',
      value: partySize[1],
      source: Source.PDF_TEXT,
      confidence: Confidence.MEDIUM,
    }));
  }

  // ── Room ──
  const room = findLabelled(lines, [/\broom\s*type\b/i, /\broom\b(?!\s*(?:type|no))/i]);
  const roomValue = room?.value?.split(/\s{2,}/)[0]?.trim();
  if (roomValue && !/^\d+$/.test(roomValue)) {
    draft.set('room', new Field({
      key: 'room',
      label: 'Room',
      value: roomValue,
      source: Source.PDF_TEXT,
      confidence: Confidence.LOW,
    }));
  }

  // ── Back of the pass ──
  //
  // The property's telephone is what a guest actually needs when they are outside at
  // night trying to find the place, which is the moment this app justifies itself.
  //
  // Numbers already claimed as the reference or PNR are excluded. Without that the
  // ten-digit PNR was reported as the hotel's phone number — a number that would ring
  // nothing, offered at exactly the moment someone needed it to work.
  const claimed = new Set([referenceField.value, draft.value('pnr')].filter(Boolean));
  const phone = findPropertyPhone(lines, claimed);

  if (phone) {
    draft.set('phone', new Field({
      key: 'phone',
      label: 'Property phone',
      value: phone,
      source: Source.PDF_TEXT,
      confidence: Confidence.LOW,
    }));
  }

  if (barcode?.text || barcode?.bytes?.length) {
    draft.barcode = barcode;
    draft.warnings.push(
      'The code on this voucher was copied across unchanged, but most hotels check you '
      + 'in by name and booking ID rather than by scanning.'
    );
  } else {
    draft.warnings.push(
      'This voucher carries no barcode, so the pass shows your booking ID as text. '
      + 'Bring a photo ID — most properties ask for one at check-in.'
    );
  }

  return draft;
}

export const lodgingAdapter = register({
  name: 'lodging',
  detect,
  build,
});

export { detect, build, readMoment, findPropertyName };
