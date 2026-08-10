/**
 * Turns a real ticket into a test fixture.
 *
 * Real documents find bugs that invented test data never will — the timezone abbreviation
 * that read as a bus operator, the barcode seat field that decoded to a plausible but
 * fictitious "0Y". Both came from actual tickets and neither was imaginable in advance.
 *
 * But real tickets cannot simply be committed. They carry a name, a booking reference and
 * a travel date, and a repository is public and permanent. So this extracts the *layout* —
 * which is what the parser reasons about — and offers to replace the values with
 * fictitious ones of the same shape. The structure is the useful part; the data is not.
 *
 *   node tools/make-fixture.mjs <ticket.pdf> <name> [--redact]
 *
 * The result lands in tests/fixtures/<name>.json and is picked up automatically.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const [, , path, name, ...flags] = process.argv;
if (!path || !name) {
  console.error('usage: node tools/make-fixture.mjs <ticket.pdf> <name> [--redact]');
  process.exit(1);
}

const redact = flags.includes('--redact');

/**
 * Replaces identifying values with fictitious ones of the same shape.
 *
 * Shape is preserved deliberately: a six-character booking reference must stay six
 * characters, or the fixture stops testing what it was built to test.
 *
 * Applied across a whole page rather than to each text item, because pdf.js splits text
 * into fragments wherever the font or spacing changes — "Mr SAMPLE R" arrives as three
 * separate items, so a pattern needing a title and a name together never matches one.
 * Names are found by looking at the fragments around a title, then every fragment
 * carrying one of those names is replaced wherever it appears.
 */
function redactPage(items) {
  const TITLE = /^(MR|MRS|MS|MISS|MSTR|MASTER|DR|PROF)\.?$/i;
  const REPLACEMENTS = ['SAMPLE', 'TRAVELLER', 'PERSON', 'GUEST'];
  const SUBSTITUTE_EMAIL = 'traveller@example.com';

  // Names sitting near a title, collected first so they can be replaced everywhere.
  const names = new Set();
  for (let i = 0; i < items.length; i++) {
    const bare = items[i].text.trim().replace(/\.$/, '');
    const hasTitle = TITLE.test(bare) || /^(mr|mrs|ms|miss|mstr|dr)\.?\s+/i.test(items[i].text.trim());

    if (!hasTitle) continue;

    // The title's own item may already contain the name. Hotel vouchers print the whole
    // thing in one run — "Mr. Sample R (Primary Guest)" — so the label that follows is
    // dropped, and the name kept as written rather than shouted.
    const inline = items[i].text.trim()
      .replace(/^(mr|mrs|ms|miss|mstr|master|dr|prof)\.?\s+/i, '')
      .replace(/\([^)]*\)/g, ' ');
    if (inline && inline !== items[i].text.trim()) {
      for (const word of inline.split(/\s+/)) if (/^[A-Za-z]{2,}$/.test(word)) names.add(word);
    }

    // And the next few fragments on roughly the same line. Only fully-capitalised words
    // are taken: a name on a ticket is invariably shouted, and anything mixed-case
    // beside it is a descriptor rather than part of the name.
    for (let next = i + 1; next < Math.min(i + 4, items.length); next++) {
      if (Math.abs(items[next].y - items[i].y) > 4) break;
      for (const word of items[next].text.split(/\s+/)) {
        if (/^[A-Z]{2,}$/.test(word) && !/^(ADULT|CHILD|INFANT|MALE|FEMALE|SENIOR)$/.test(word)) {
          names.add(word);
        }
      }
    }
  }

  const NOT_A_NAME = /^(name|age|gender|status|booking|current|passenger|details|adult|child|infant|male|female|cnf|rac|wl|sr|no|of|on|to|in|at|the|and|for|per|km|hrs)$/i;

  // Names in a salutation rather than beside a title.
  //
  // An emailed ticket opens "Dear SAMPLE R" — no honorific, no column header, so
  // neither of the other two scans sees it. Worth noting that this addressee is the
  // account holder and often *not* the passenger, but both are equally identifying.
  for (const item of items) {
    const salutation = item.text.trim().match(/^(?:dear|hi|hello)\s+(.+)$/i);
    if (!salutation) continue;

    // Consecutive shouted words only; stop at the first token that is not one, which
    // is what separates "SAMPLE" from the "C(User Id: …)" that follows it.
    for (const word of salutation[1].split(/\s+/)) {
      if (!/^[A-Z]{2,}$/.test(word) || NOT_A_NAME.test(word)) break;
      names.add(word);
    }
  }

  // Names announced by a label rather than a column header.
  //
  // An invoice writes "Customer Name" and puts the value beside it. The column scan
  // below only matches a cell *starting* with "Name", so these survived untouched — and
  // unlike a boarding pass, an invoice prints the name in mixed case, which the
  // all-capitals rule would also have missed.
  //
  // A *bare* "Name" is deliberately excluded here: that is a column header, whose value
  // is underneath, and whose right-hand neighbour is the next header along. Treating it
  // as a label replaced the word "Seat" on an airline itinerary with a person's name.
  const NAME_LABEL = /^(?:customer|guest|passenger|traveller|primary|lead|company\s*(?:legal|trade))\s*name\s*:?$/i;

  for (let i = 0; i < items.length; i++) {
    if (!NAME_LABEL.test(items[i].text.trim())) continue;

    for (const candidate of items) {
      const sameLine = Math.abs(candidate.y - items[i].y) <= 4 && candidate.x > items[i].x;
      const beneath = candidate.y > items[i].y
        && candidate.y <= items[i].y + 24
        && Math.abs(candidate.x - items[i].x) <= 12;
      if (!sameLine && !beneath) continue;

      const cleaned = candidate.text.trim();
      if (!cleaned || cleaned.length > 40 || cleaned.split(/\s+/).length > 4) continue;
      if (!/^[A-Z]/.test(cleaned)) continue;

      for (const word of cleaned.split(/\s+/)) {
        if (/^[A-Za-z]{2,}$/.test(word) && !NOT_A_NAME.test(word)) names.add(word);
      }
      break;
    }
  }

  // Names in a table column rather than beside a title.
  //
  // Rail tickets carry no honorifics: IRCTC prints a "# Name" column header with the
  // traveller beneath it. Without this the name survives redaction untouched, which is
  // the one failure this tool exists to prevent.
  //
  // Kept tight deliberately. An earlier version scanned a generous band below the header
  // and swept up ordinary prose, so common words were replaced throughout the document
  // and the fixture became unreadable — and, worse, stopped resembling a real ticket.
  for (let i = 0; i < items.length; i++) {
    if (!/^#?\s*name\b/i.test(items[i].text.trim())) continue;

    const column = items[i].x;
    for (const candidate of items) {
      // Directly beneath the header, aligned with its column, and within the few rows a
      // passenger table occupies.
      if (candidate.y <= items[i].y || candidate.y > items[i].y + 60) continue;
      if (Math.abs(candidate.x - column) > 12) continue;

      // A name cell is short and starts with a row number or a capital.
      const cleaned = candidate.text.replace(/^\s*\d+\s*[.)]\s*/, '').trim();
      if (!cleaned || cleaned.length > 40 || cleaned.split(/\s+/).length > 4) continue;
      if (!/^[A-Z]/.test(cleaned)) continue;

      for (const word of cleaned.split(/\s+/)) {
        // Only words that are entirely capitals, as names on tickets invariably are.
        if (/^[A-Z]{2,}$/.test(word) && !NOT_A_NAME.test(word)) names.add(word);
      }
    }
  }

  // Fellow travellers listed beside a name already known.
  //
  // A hotel voucher names the lead guest against a label and then lists the whole party
  // on the line below — "Sample R, Traveller MS". Only the first is reachable by any
  // of the scans above, so the rest would survive untouched.
  //
  // Two or more comma-separated parts are required, which is what makes it a list. A
  // single trailing comma is a salutation — "Dear Sample," — and treating that as a
  // list added the word "Dear" to the set of names and replaced it throughout.
  for (const item of items) {
    const parts = item.text.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    if (![...names].some((name) => new RegExp(`\\b${name}\\b`, 'i').test(item.text))) continue;

    for (const part of parts) {
      if (part.split(/\s+/).length > 4) continue;
      for (const word of part.split(/\s+/)) {
        if (/^[A-Za-z]{2,}$/.test(word) && !NOT_A_NAME.test(word)) names.add(word);
      }
    }
  }

  // Email addresses broken across text items.
  //
  // pdf.js splits a run wherever spacing or font changes, so "traveller@example.com"
  // can arrive as "traveller@example.com" + "il.com" and the address pattern — which only ever
  // sees one item at a time — matches neither half. The substitute is cut at the same
  // relative position, keeping the fragmentation the extractor has to cope with.
  const EMAIL = /^[\w.*-]+@[\w.-]+\.\w{2,}$/;
  const fragments = new Map();

  for (let i = 0; i < items.length; i++) {
    if (fragments.has(i) || !items[i].text.includes('@') || EMAIL.test(items[i].text.trim())) continue;

    let joined = items[i].text.trim();
    for (let next = i + 1; next < Math.min(i + 3, items.length); next++) {
      const sameLine = Math.abs(items[next].y - items[i].y) <= 4;
      // Or wrapped onto the next line of a narrow column, which is how a long address
      // in a contact panel actually breaks.
      const wrapped = items[next].y > items[i].y
        && items[next].y - items[i].y <= 20
        && Math.abs(items[next].x - items[i].x) <= 2;
      if (!sameLine && !wrapped) break;

      joined += items[next].text.trim();
      if (!EMAIL.test(joined)) continue;

      // Distribute the substitute across the fragments in the original proportions.
      const parts = [];
      for (let k = i; k <= next; k++) parts.push(items[k].text.trim().length);
      const total = parts.reduce((a, b) => a + b, 0);

      let taken = 0;
      for (let k = i; k <= next; k++) {
        const share = k === next
          ? SUBSTITUTE_EMAIL.slice(taken)
          : SUBSTITUTE_EMAIL.slice(taken, taken + Math.round((parts[k - i] / total) * SUBSTITUTE_EMAIL.length));
        fragments.set(k, share);
        taken += share.length;
      }
      break;
    }
  }

  const swap = new Map();
  let n = 0;
  for (const name of names) {
    swap.set(name, REPLACEMENTS[n % REPLACEMENTS.length] + (n >= REPLACEMENTS.length ? String(n) : ''));
    n++;
  }

  // The property's name.
  //
  // A hotel is not private, but *which* hotel someone stayed at, on which dates, is. The
  // name is replaced consistently wherever it appears — including inside the address
  // line, where it is usually repeated in capitals.
  const VENUE = /\b([A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*){0,4}\s+(?:Resort(?:\s+And\s+Spa)?|Hotel|Inn|Lodge|Residency|Guest\s*House|Homestay|Hostel|Palace|Grand|Suites?))\b/;

  const venues = new Set();
  for (const item of items) {
    const match = item.text.match(VENUE);
    if (match) venues.add(match[1].trim());
  }

  for (const venue of venues) {
    // Both as written and shouted, since address blocks repeat it in capitals.
    swap.set(venue, 'Sample Resort And Spa');
    swap.set(venue.toUpperCase(), 'SAMPLE RESORT AND SPA');
  }

  // Distinct ten-digit originals get distinct ten-digit substitutes, stable across the
  // page so the same number reads the same wherever it appears.
  const tenDigits = new Map();
  const tenDigit = (value) => {
    if (!tenDigits.has(value)) {
      tenDigits.set(value, String(1234567890 + tenDigits.size * 111111));
    }
    return tenDigits.get(value);
  };

  return items.map((item, index) => {
    if (fragments.has(index)) return { ...item, text: fragments.get(index) };

    let text = item.text;

    // Names, wherever they appear on the page. Word-bounded, so a name is not matched
    // inside an ordinary word.
    //
    // Longer names are matched without regard to case: a hotel voucher writes "Sample"
    // where a boarding pass shouts "SAMPLE", and the same person must be replaced in
    // both. Short ones stay case-sensitive, because a two-letter surname like "MS" would
    // otherwise match the word "ms" throughout the document.
    for (const [name, replacement] of swap) {
      const flags = name.length >= 4 ? 'gi' : 'g';
      text = text.replace(new RegExp(`\\b${name}\\b`, flags), replacement);
    }

    // A lone initial left stranded beside a replaced name: "SAMPLE C" still narrows a
    // person down, and the initial carries nothing the fixture needs.
    for (const replacement of swap.values()) {
      text = text.replace(new RegExp(`\\b${replacement}\\s+[A-Z]\\b(?!\\w)`, 'g'), replacement);
    }

    return {
      ...item,
      text: text
        // Booking references: six alphanumerics with at least one digit and one letter.
        //
        // Validated in a callback rather than by lookahead. An earlier version used
        // `(?=.*\d)`, which is not scoped to the six characters and so matched a digit
        // anywhere later in the line — turning the ordinary word "RESORT" into a booking
        // reference because "4TH" appeared further along the address.
        .replace(/\b[A-Z0-9]{6}\b/g, (m) => (/\d/.test(m) && /[A-Z]/.test(m) ? 'AB1CD2' : m))
        // Longer agent references — MakeMyTrip issues "NH99999999999999". Letters then a
        // long digit run, replaced in the same shape so the parser still has to cope
        // with the length that made it distinctive.
        .replace(/\b([A-Z]{2,3})\d{8,18}\b/g, (m, prefix) => prefix + '9'.repeat(m.length - prefix.length))
        // Ten-digit numbers: rail PNRs, and Indian telephone numbers written bare.
        //
        // Each distinct original gets a distinct substitute. Collapsing them all to one
        // value destroyed exactly what a fixture is for: a hotel voucher prints a
        // ten-digit PNR *and* the property's ten-digit telephone number, and the whole
        // point of the code under test is telling those two apart. Redacted to the same
        // digits, they became indistinguishable and the test could not fail honestly.
        //
        // Deliberately before the telephone pattern, which would otherwise swallow these
        // and destroy the shape the fixture exists to test.
        .replace(/\b\d{10}\b/g, (m) => tenDigit(m))
        // Long transaction and ticket numbers.
        .replace(/\b\d{11,}\b/g, (m) => '9'.repeat(m.length))
        // Telephone numbers, including the masked forms tickets already print. Requires
        // a separator or a country code, so a bare run of digits is left alone.
        .replace(/\+\d[\dX*\s-]{7,}\d/gi, '+91-90000-00000')
        .replace(/\b\d{2,5}[\s-][\dX*\s-]{6,}\d\b/gi, '90000-00000')
        // A display name in front of an address — "Sample <t@example.com>" — which the
        // address pattern alone leaves standing. Email tickets only; no PDF prints this.
        .replace(/[A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*){0,3}\s*(?=<[\w.*-]+@[\w.-]+\.\w{2,}>)/g, 'Traveller ')
        // Account usernames, which identify a person as squarely as their name does.
        .replace(/\b(user\s?(?:id|name)|username|login)(\s*[:=]\s*)[\w.@-]+/gi, '$1$2traveller')
        .replace(/\b[\w.*-]+@[\w.-]+\.\w{2,}\b/g, 'traveller@example.com')
        // Masked contact fragments, which are identifying enough to be worth removing.
        .replace(/\b[a-z]\*[X*]{4,}[a-z]*\b/gi, 'traveller@example.com')
        .replace(/\b\d{2,}X{3,}\d{2,}\b/gi, '90000-00000')
        // Government and corporate tax identifiers — Indian GSTIN, then PAN. Printed
        // publicly on a company's own invoice rather than being anyone's private data,
        // but they are government identifiers and a fixture has no use for the real ones.
        .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}\b/g, '00XXXXX0000X0XX')
        .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, 'XXXXX0000X')
        // Card fragments.
        .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '4111 1111 1111 1111')
        // Street addresses. Where someone stayed, or lives, is as identifying as their
        // name — and unlike a booking reference the shape carries no meaning worth
        // preserving, so a single stand-in serves for the whole line.
        .replace(/\b\d+[/-]\d+[^,]*,\s*(?:WARD|F NO|FLAT|DOOR|H NO|PLOT)[^|]*/gi, '1/1 SAMPLE STREET')
        .replace(/\b(?:WARD\s*No\.?\s*\d+|4TH WARD[^,]*)/gi, 'WARD No.1'),
    };
  });
}

const data = new Uint8Array(await readFile(path));
const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise;

const pages = [];
for (let n = 1; n <= Math.min(doc.numPages, 2); n++) {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });

  let items = content.items
    .filter((item) => item.str?.trim())
    .map((item) => ({
      text: item.str,
      // Rounded: sub-pixel precision is noise, and it makes the fixture unreadable.
      x: Math.round(item.transform[4] * 10) / 10,
      y: Math.round((viewport.height - item.transform[5]) * 10) / 10,
      width: Math.round(item.width * 10) / 10,
      height: Math.round((item.height || Math.abs(item.transform[3]) || 10) * 10) / 10,
    }));

  if (redact) items = redactPage(items);

  pages.push({ width: Math.round(viewport.width), height: Math.round(viewport.height), items });
}

const fixture = {
  name,
  // The original filename is itself identifying — an IRCTC ticket is named after its
  // PNR — so only the kind of document is recorded.
  source: redact ? path.replace(/.*\.(\w+)$/, '$1') : basename(path),
  redacted: redact,
  capturedAt: new Date().toISOString().slice(0, 10),
  pages,
  // Filled in by hand once the fixture is reviewed: what the parser *should* produce.
  // Left empty rather than pre-filled from current behaviour, since a fixture that
  // asserts today's output would only ever confirm that nothing changed.
  expect: {},
};

await mkdir(new URL('../tests/fixtures/', import.meta.url), { recursive: true });
const out = new URL(`../tests/fixtures/${name}.json`, import.meta.url);
await writeFile(out, `${JSON.stringify(fixture, null, 1)}\n`);

const bytes = JSON.stringify(fixture).length;
console.log(`wrote tests/fixtures/${name}.json — ${pages[0].items.length} items, ${(bytes / 1024).toFixed(1)} KB${redact ? ', redacted' : ''}`);
console.log('\nFill in the "expect" block with what this ticket should produce, for example:');
console.log(JSON.stringify({
  expect: { adapter: 'flight', type: 'flight', fields: { pnr: 'AB1CD2', origin: 'BLR', destination: 'IXE' } },
}, null, 1));
