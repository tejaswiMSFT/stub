/**
 * Adapter registry — decides what kind of ticket we are looking at.
 *
 * Each adapter inspects the barcode payload and reconstructed text, then declares how
 * confident it is. The highest scorer wins. This keeps ticket-type knowledge isolated:
 * adding rail or a specific cinema chain means adding an adapter, not editing a
 * growing conditional in the middle of the pipeline.
 *
 * Adapters never guess silently. Anything uncertain becomes a low-confidence field so
 * the review screen can insist the user looks at it.
 */

import { decodeBCBP, COMPARTMENT } from '../bcbp.js';
import { Field, Source, Confidence, TicketDraft } from '../model.js';
import { buildLines, findValueForLabel, toPlainText } from '../text.js';
import { IngestError } from '../errors.js';

const registry = [];

export function register(adapter) {
  registry.push(adapter);
  return adapter;
}

/**
 * Picks the best adapter. The generic adapter always accepts, guaranteeing a usable
 * result rather than an error page for an unrecognised ticket.
 */
export function selectAdapter(context) {
  const scored = registry
    .map((adapter) => ({ adapter, score: adapter.detect(context) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

export async function extract(context) {
  const best = selectAdapter(context);

  // Refusing is the right answer for a document that is not a ticket — an electricity
  // bill, tested here, has a reference number, dates and a name, and could be dressed up
  // into something that looks like a pass. Saying so plainly is better than producing a
  // convincing pass for a bill, and better than blaming the user's camera.
  if (!best) {
    throw new IngestError(
      "This doesn't look like a ticket.",
      { hint: 'Try the booking confirmation itself, rather than a receipt, invoice or statement.' },
    );
  }

  const draft = await best.adapter.build(context);
  draft.adapterScore = best.score;
  return draft;
}

// ────────────────────────────── shared helpers ──────────────────────────────

/** Times on tickets appear in many shapes; this normalises to 24-hour HH:MM. */
export function parseTime(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  // An explicit separator is unambiguous: 16:40, 4.05 pm, 16h40. Seconds are allowed
  // and discarded, so "02:34:15 PM" still reads its meridiem.
  let match = text.match(/\b(\d{1,2})\s*[:.h]\s*(\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i);

  // A bare run of digits is only a time when something says so — "0700 hrs", or a
  // meridiem. Accepting it unannounced meant the year in "01-Jun-2025 16:40" matched
  // before the time did, and the arrival was reported as 20:25: plausible, confident,
  // and entirely invented. A wrong time on a pass is worse than no time at all.
  if (!match) match = text.match(/\b(\d{1,2})(\d{2})\s*(?:hrs?|hours)\b/i);
  if (!match) match = text.match(/\b(\d{1,2})[\s.]?(\d{2})\s*(a\.?m\.?|p\.?m\.?)/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3]?.toLowerCase().replace(/\./g, '');

  if (minutes > 59) return null;
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23) return null;

  return {
    hours,
    minutes,
    text: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    hadMeridiem: Boolean(meridiem),
  };
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parses dates found in ticket text.
 *
 * Deliberately refuses ambiguous all-numeric forms like 09/10/2026 unless one
 * component exceeds 12. Guessing DD/MM versus MM/DD wrongly would send the user to
 * the airport on the wrong day — a confidently wrong date is far worse than an empty
 * field the user is asked to fill.
 */
export function parseDate(raw, { reference = new Date() } = {}) {
  if (!raw) return null;
  const text = String(raw).trim();

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return { date: new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])), ambiguous: false, hadYear: true };
  }

  // 16 Sep 2026 / 16-SEP-26 — unambiguous because the month is named.
  const dayFirst = text.match(/\b(\d{1,2})[\s\-/]*([a-z]{3,4})[\s\-/]*(\d{2,4})?\b/i);
  const monthFirst = text.match(/\b([a-z]{3,4})[\s\-/]*(\d{1,2})(?:st|nd|rd|th)?[\s,\-/]*(\d{2,4})?\b/i);
  const named = dayFirst || monthFirst;

  if (named) {
    const isMonthFirst = named === monthFirst && !dayFirst;
    const dayText = isMonthFirst ? named[2] : named[1];
    const monthText = isMonthFirst ? named[1] : named[2];
    const day = parseInt(dayText, 10);
    const monthKey = String(monthText).toLowerCase().slice(0, 4);
    const month = MONTHS[monthKey] ?? MONTHS[monthKey.slice(0, 3)];

    if (month !== undefined && day >= 1 && day <= 31) {
      let year = named[3] ? parseInt(named[3], 10) : reference.getFullYear();
      if (year < 100) year += 2000;
      return { date: new Date(Date.UTC(year, month, day)), ambiguous: false, hadYear: Boolean(named[3]) };
    }
  }

  const numeric = text.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/);
  if (numeric) {
    const a = parseInt(numeric[1], 10);
    const b = parseInt(numeric[2], 10);
    let year = parseInt(numeric[3], 10);
    if (year < 100) year += 2000;

    if (a > 12 && b <= 12) return { date: new Date(Date.UTC(year, b - 1, a)), ambiguous: false, hadYear: true };
    if (b > 12 && a <= 12) return { date: new Date(Date.UTC(year, a - 1, b)), ambiguous: false, hadYear: true };

    // Both plausible as a month — report the ambiguity rather than choosing.
    return {
      date: null,
      ambiguous: true,
      candidates: [new Date(Date.UTC(year, b - 1, a)), new Date(Date.UTC(year, a - 1, b))],
      hadYear: true,
    };
  }

  return null;
}

/**
 * Combines a date, time and zone offset into the ISO string Wallet requires.
 *
 * Apple mandates an offset. Paired with `ignoresTimeZone: true`, the pass then shows
 * that wall-clock time regardless of the device's own zone — exactly right for a
 * departure or a showtime, both of which are local to the venue.
 */
export function toWalletDate(date, time, offsetMinutes = null) {
  if (!date) return null;
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');

  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(time?.hours ?? 0);
  const minutes = pad(time?.minutes ?? 0);

  let offset = 'Z';
  if (offsetMinutes !== null && offsetMinutes !== undefined) {
    const sign = offsetMinutes >= 0 ? '+' : '-';
    offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  }

  return `${year}-${month}-${day}T${hours}:${minutes}:00${offset}`;
}

function regionOf(match) {
  if (!match?.region) return null;
  const { x, y, width, height } = match.region;
  return { x, y, width, height };
}

/** Tries several label spellings, returning the first hit plus its source region. */
export function findLabelled(lines, patterns, options = {}) {
  for (const pattern of patterns) {
    const match = findValueForLabel(lines, pattern, options);
    if (match?.value) {
      // `line` is carried through so callers can look at what sits around the value.
      // Hotels print a check-in time on the line *below* the date, which is unreachable
      // from a region alone.
      return {
        value: match.value.trim(),
        region: regionOf(match),
        relation: match.relation,
        line: match.line,
      };
    }
  }
  return null;
}

/**
 * Identifies the ticket provider for the pass header.
 *
 * Providers are found from the document's own prominent text rather than a hardcoded
 * brand list — a maintained list of every airline and cinema chain worldwide would be
 * perpetually incomplete, and a wrong brand name is worse than none.
 */
export function findProvider(lines, { hint = null } = {}) {
  if (hint) return { value: hint, region: null, confidence: Confidence.HIGH };

  // The largest text near the top of a ticket is almost always the provider's name.
  const top = lines.filter((line) => line.y < Math.max(...lines.map((l) => l.y)) * 0.28);
  if (!top.length) return null;

  const tallest = [...top].sort((a, b) => b.height - a.height)[0];
  if (!tallest) return null;

  const text = tallest.text.trim();
  // Reject values that are plainly data rather than a brand.
  if (!text || text.length > 40 || /\d{4,}/.test(text)) return null;

  return {
    value: text,
    region: { x: tallest.x, y: tallest.y, width: tallest.width, height: tallest.height },
    confidence: Confidence.LOW,
  };
}

export {
  registry, buildLines, findValueForLabel, toPlainText,
  decodeBCBP, COMPARTMENT, Field, Source, Confidence, TicketDraft,
};
