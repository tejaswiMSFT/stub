/**
 * Text layout reconstruction.
 *
 * pdf.js hands back text as scattered runs with coordinates, not as readable lines.
 * A ticket's meaning lives in its layout — "SEAT" above "10F" means one thing, and
 * "SEAT" beside an unrelated column means another — so we rebuild lines and columns
 * before any field matching happens.
 *
 * Every reconstructed line keeps its bounding box, because the review screen
 * highlights the exact region a value came from. That visual link is what lets a user
 * verify a field in a second rather than re-reading their whole ticket.
 */

/** Runs whose vertical centres sit within this fraction of line height are one line. */
const LINE_TOLERANCE = 0.55;
/** A horizontal gap wider than this many spaces implies separate columns. */
const COLUMN_GAP_RATIO = 1.6;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Groups runs into visual lines.
 *
 * Sorting purely by y fails on tickets, which frequently place a label and its value
 * at slightly different baselines within the same visual row. Tolerance is derived
 * from the document's own median glyph height so it adapts to the page scale rather
 * than assuming a fixed point size.
 */
export function buildLines(items) {
  if (!items.length) return [];

  const typicalHeight = median(items.map((item) => item.height).filter(Boolean)) || 10;
  const tolerance = typicalHeight * LINE_TOLERANCE;

  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];

  for (const item of sorted) {
    const centre = item.y + item.height / 2;
    const line = lines.find((candidate) => Math.abs(candidate.centre - centre) <= tolerance);

    if (line) {
      line.items.push(item);
      // Re-average so a long line doesn't drift from its first run's baseline.
      line.centre = line.items.reduce((sum, i) => sum + i.y + i.height / 2, 0) / line.items.length;
    } else {
      lines.push({ centre, items: [item] });
    }
  }

  return stripMailChrome(lines
    .map((line) => finaliseLine(line, typicalHeight))
    .sort((a, b) => a.y - b.y));
}

/**
 * Removes the mail client's own furniture from a confirmation printed to PDF.
 *
 * A ticket forwarded or printed from Gmail arrives wrapped in headers, and those headers
 * are laid out exactly like ticket data: a short caption, a colon, a value. "To:
 * someone@example.com" sits above the ticket and matches a destination label far more
 * readily than the "To : MANGALURU JN (MAJN)" further down, so the pass ends up bound
 * for an email address.
 *
 * Only lines carrying an address are removed. The subject line is kept — it frequently
 * summarises the journey, and it can never be mistaken for a field value.
 */
function stripMailChrome(lines) {
  const ADDRESS = /[\w.*-]+@[\w.-]+\.\w{2,}/;
  const HEADER = /^\s*(to|from|cc|bcc|reply-?to|sender|sent|date)\s*:/i;

  return lines.filter((line) => {
    const text = line.text.trim();
    if (!ADDRESS.test(text)) return true;

    // "To: someone@example.com"
    if (HEADER.test(text)) return false;

    // A bare address, or a display name in front of one — the From line as Gmail prints
    // it. Anything longer is prose that happens to mention an address, such as the
    // support contact printed at the foot of a real ticket.
    if (/^<?[\w.*-]+@[\w.-]+\.\w{2,}>?$/.test(text)) return false;
    if (/^.{0,60}<[^>]*@[^>]*>$/.test(text)) return false;

    return true;
  });
}

function finaliseLine(line, typicalHeight) {
  const items = [...line.items].sort((a, b) => a.x - b.x);
  const x = Math.min(...items.map((i) => i.x));
  const y = Math.min(...items.map((i) => i.y));
  const right = Math.max(...items.map((i) => i.x + i.width));
  const bottom = Math.max(...items.map((i) => i.y + i.height));

  // Reassemble with spacing inferred from gaps, since pdf.js often splits mid-word.
  let text = '';
  let previous = null;

  for (const item of items) {
    const spaceWidth = (item.height || typicalHeight) * 0.28;
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      if (gap > spaceWidth * COLUMN_GAP_RATIO) text += '  ';
      else if (gap > spaceWidth * 0.35 && !text.endsWith(' ')) text += ' ';
    }
    text += item.text;
    previous = item;
  }

  const collapsed = text.replace(/[ \t]+/g, ' ').trim();

  return {
    text: collapsed,
    raw: items.map((i) => i.text).join(''),
    items,
    x,
    y,
    width: right - x,
    height: bottom - y,
    /** Uppercase-only short runs are usually labels, not values. */
    looksLikeLabel: /^[A-Z][A-Z\s/&.'-]{1,24}:?$/.test(collapsed) && collapsed.length <= 26,
  };
}

/**
 * Splits a line into columns where horizontal gaps are unusually wide.
 *
 * Tickets are built from columns — FROM | TO, SEAT | GATE — and a naive left-to-right
 * read welds them into nonsense. Detecting the gaps preserves the association between
 * a label and the value beneath it.
 */
/**
 * Splits a line into columns at visible gaps.
 *
 * Tickets are built from columns — FROM | TO, SEAT | GATE — and a naive left-to-right
 * read welds them into nonsense. Detecting the gaps preserves the association between a
 * label and the value beneath it.
 *
 * The threshold is derived from the *typical* gap on this line rather than an absolute
 * width, because a ticket set in 6pt has different spacing from one set in 12pt. A
 * column boundary is a gap several times wider than the ordinary word spacing around
 * it; a fixed multiple of font size would misjudge both extremes.
 */
export function splitColumns(line, typicalHeight = 10) {
  const items = line.items;
  if (!items || items.length < 2) {
    return [{ text: line.text, x: line.x, width: line.width, y: line.y, height: line.height, items: items || [] }];
  }

  const fontSize = median(items.map((item) => item.height).filter(Boolean)) || typicalHeight;

  // Judged against font size alone, not against the other gaps on the line.
  //
  // An earlier version compared each gap to the line's median gap, which fails exactly
  // where it matters most: on a row that is *entirely* columns, the median gap is itself
  // a column gap, the threshold becomes enormous, and the row collapses into one column.
  // Font size is stable and knowable — a word space is roughly a third of it, and a
  // column gap is invariably more than a whole em.
  const threshold = fontSize * 1.05;

  const columns = [];
  let current = [items[0]];

  for (let i = 1; i < items.length; i++) {
    const gap = items[i].x - (items[i - 1].x + items[i - 1].width);
    if (gap > threshold) {
      columns.push(current);
      current = [items[i]];
    } else {
      current.push(items[i]);
    }
  }
  columns.push(current);

  return columns.map((group) => {
    const x = Math.min(...group.map((i) => i.x));
    const right = Math.max(...group.map((i) => i.x + i.width));
    const top = Math.min(...group.map((i) => i.y));
    return {
      text: group.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim(),
      x,
      width: right - x,
      y: top,
      height: Math.max(...group.map((i) => i.y + i.height)) - top,
      items: group,
    };
  }).filter((c) => c.text);
}

/**
 * Finds the value belonging to a label.
 *
 * Tickets pair labels with values two ways, and telling them apart is the whole job:
 *
 *   Beside — "Seat: 14A", or "Coach   S7" separated by a gap.
 *   Beneath — a header row of captions with values column-aligned underneath, which is
 *   how nearly every rail and airline ticket lays out its principal details.
 *
 * These are indistinguishable from a single line of text. "PNR   Train No./Name   Class"
 * looks, to a naive read-along, exactly like a label followed by its value — and yields
 * a booking reference of "Train".
 *
 * The resolution is order of preference, not cleverness:
 *
 *   1. Text after the label *within the label's own column* is unambiguously its value.
 *   2. If the label ends in a colon it is one half of a "Label : value" pair, and the
 *      value is the column beside it. Table headers never carry colons.
 *   3. Otherwise look directly beneath. A header row has its values there; a
 *      label-and-value row has nothing.
 *   4. Only when nothing lies beneath does the neighbouring column become the value.
 *
 * Trying below before beside is what makes the header case work, and costs the
 * label-value case nothing: it simply finds nothing underneath and falls through.
 */
export function findValueForLabel(lines, labelPattern, options = {}) {
  const { maxBelowDistance = 3.2, sameLine = true, below = true } = options;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!labelPattern.test(line.text)) continue;

    const columns = splitColumns(line);

    // A caption begins its cell, or follows a word or two of qualifier — "Booked From",
    // "Start Date*", "Scheduled Departure". What it never does is appear part-way
    // through a sentence: "To" matched the word "to" in "please do not reply to this
    // email ID" and returned the rest of the sentence, from which the destination was
    // read as "IRCTC". Prose gives itself away by its length and its full stops.
    const labelIndex = columns.findIndex((column) => {
      const cell = column.text.trim();
      const match = cell.match(labelPattern);
      if (!match) return false;

      const prefix = cell.match(/^[#*\d.)\s-]*/)[0].length;
      if (match.index <= prefix) return true;

      const before = cell.slice(prefix, match.index);
      return cell.length <= 80 && before.length <= 20 && !/[.!?;:]/.test(before);
    });
    if (labelIndex === -1) continue;

    const labelColumn = columns[labelIndex];

    // A label ending in a colon announces its own value, and that value sits beside it.
    // Table headers do not carry colons, so this cleanly separates the two layouts an
    // Indian rail ticket can use: a header row with values stacked beneath, and a grid
    // of "Label : value" pairs laid three across a row.
    const pairForm = /[:：]\s*$/.test(labelColumn.text.trim());

    // The next column along.
    //
    // Only ever the column to the right. Falling back to the left finds the *previous*
    // label — "Class" would take its value from "Train No./Name" — and reading order is
    // not ambiguous enough to justify guessing backwards.
    const beside = () => {
      if (!sameLine) return null;
      const neighbour = columns[labelIndex + 1];
      if (!neighbour?.text || labelPattern.test(neighbour.text)) return null;
      return { value: neighbour.text.trim(), line, region: neighbour, relation: 'beside' };
    };

    // ── 1. Within the label's own column ──
    if (sameLine) {
      const match = labelColumn.text.match(labelPattern);
      const rest = labelColumn.text.slice(match.index + match[0].length);
      const after = rest.replace(/^[\s:—–*†‡#-]+/, '').trim();

      // A remainder beginning with punctuation means the pattern cut a compound label
      // in half — "Train No./Name" matched as "Train No", leaving "./Name", which is
      // the label's own tail rather than a value. Falling through to look below is
      // right; taking it would report the field as "./Name".
      const cutMidLabel = /^[./\\&|]/.test(rest.trim());

      // Nor is a remainder of pure punctuation a value. "Scheduled Departure* :" leaves
      // "* :" once the label matches, and reporting a departure time of "* :" is worse
      // than reporting none — it looks like data.
      const hasContent = /[\p{L}\p{N}]/u.test(after);

      if (after && hasContent && !cutMidLabel) {
        return { value: after, line, region: labelColumn, relation: 'beside' };
      }
    }

    // ── 2. Beside, when the label's colon says its value belongs there ──
    if (pairForm) {
      const found = beside();
      if (found) return found;
    }

    // ── 3. Directly beneath ──
    if (below) {
      const found = valueBelow(lines, index, labelColumn, labelPattern, maxBelowDistance);
      if (found) return found;
    }

    // ── 4. The next column along ──
    if (!pairForm) {
      const found = beside();
      if (found) return found;
    }
  }

  return null;
}

/**
 * Looks for a value in the column directly beneath a label.
 *
 * Alignment is judged against the narrower of the two columns: a short caption like
 * "To" sits above a long station name, and requiring the wide value to overlap most of
 * the narrow label would reject the very pairing being sought.
 */
function valueBelow(lines, index, labelColumn, labelPattern, maxDistance) {
  const line = lines[index];
  const labelColumnCount = splitColumns(line).length;

  for (let next = index + 1; next < lines.length; next++) {
    const candidate = lines[next];
    const distance = (candidate.y - (line.y + line.height)) / (line.height || 10);

    if (distance > maxDistance) break;
    if (distance < -0.5) continue;

    const columns = splitColumns(candidate);

    // A single-column line beneath a multi-column row is a section heading, not the
    // table's data. "PNR/Booking Reference | QP4RT9 | Confirmed" followed by the heading
    // "Passenger Information" would otherwise report the booking reference as
    // "Passenger Information" — the value was beside it all along.
    if (labelColumnCount >= 3 && columns.length < 2) continue;

    let best = null;
    let bestOverlap = 0;

    for (const column of columns) {
      const overlap = Math.min(column.x + column.width, labelColumn.x + labelColumn.width)
        - Math.max(column.x, labelColumn.x);
      if (overlap <= 0) continue;

      const ratio = overlap / Math.max(1, Math.min(column.width, labelColumn.width));
      if (ratio > 0.45 && overlap > bestOverlap) {
        best = column;
        bestOverlap = overlap;
      }
    }

    if (!best?.text) continue;

    // A row that repeats the label is another header, not the value.
    if (labelPattern.test(best.text)) continue;

    // Nor is another label. A value never ends in a colon, so a cell that does is the
    // next caption in a label-and-value grid rather than anything belonging to this one.
    //
    // Emailed IRCTC confirmations lay three label:value pairs across a row and stack the
    // rows, so directly beneath "PNR No. :" sits "Transaction ID :" — perfectly aligned,
    // and utterly wrong. Without this the booking reference reads "Transaction".
    if (/[:：]\s*$/.test(best.text)) continue;

    return { value: best.text.trim(), line: candidate, region: best, relation: 'below' };
  }

  return null;
}

/**
 * Reads a table: a header row of captions with data rows beneath.
 *
 * Distinct from `findValueForLabel`, which finds one value for one label. Tickets
 * routinely carry genuine tables — a passenger list with a row per traveller, a fare
 * breakdown, a list of legs — where the interesting thing is the *rows*, and reading
 * them one field at a time loses which value belongs to which passenger.
 *
 * The header is located by requiring several of the given captions to appear on one
 * line, which is what distinguishes a real header from a stray occurrence of the word
 * "Name" in a paragraph. Data rows are then read by column alignment until a row no
 * longer aligns, which is how the table's end is detected without needing to be told.
 *
 * @param headers  patterns keyed by the name each column should take
 * @param minMatch how many must appear before a line counts as a header
 */
export function readTable(lines, headers, { minMatch = 2, maxRows = 12, maxGap = 3.0 } = {}) {
  const names = Object.keys(headers);

  for (let index = 0; index < lines.length; index++) {
    const columns = splitColumns(lines[index]);
    if (columns.length < minMatch) continue;

    // Map each caption to the column it was found in.
    const positions = {};
    let matched = 0;

    for (const name of names) {
      const column = columns.find((candidate) => headers[name].test(candidate.text));
      if (column) { positions[name] = column; matched++; }
    }

    if (matched < minMatch) continue;

    const rows = [];
    const header = lines[index];

    for (let next = index + 1; next < lines.length && rows.length < maxRows; next++) {
      const line = lines[next];
      const distance = (line.y - (header.y + header.height)) / (header.height || 10);
      if (distance > maxGap * (rows.length + 1)) break;

      const cells = splitColumns(line);
      const row = {};
      let filled = 0;

      for (const [name, headerColumn] of Object.entries(positions)) {
        const cell = cells.find((candidate) => {
          const overlap = Math.min(candidate.x + candidate.width, headerColumn.x + headerColumn.width)
            - Math.max(candidate.x, headerColumn.x);
          return overlap > Math.min(candidate.width, headerColumn.width) * 0.35;
        });
        if (cell?.text) { row[name] = cell.text.trim(); filled++; }
      }

      // A line that lines up with nothing is past the end of the table.
      if (!filled) {
        if (rows.length) break;
        continue;
      }

      rows.push({ ...row, line });
    }

    if (rows.length) return { headerLine: header, columns: positions, rows };
  }

  return null;
}

/** Concatenated plain text, used for coarse pattern matching across the whole ticket. */
export function toPlainText(lines) {
  return lines.map((line) => line.text).join('\n');
}

/**
 * Converts OCR output into the same line shape as PDF extraction, so everything
 * downstream is source-agnostic and only the confidence tier differs.
 */
export function linesFromOcr(ocrWords, { scale = 1 } = {}) {
  const items = ocrWords
    .filter((word) => word.text && word.text.trim())
    .map((word) => ({
      text: word.text,
      x: word.bbox.x0 / scale,
      y: word.bbox.y0 / scale,
      width: (word.bbox.x1 - word.bbox.x0) / scale,
      height: (word.bbox.y1 - word.bbox.y0) / scale,
      confidence: word.confidence,
    }));

  const lines = buildLines(items);
  for (const line of lines) {
    // Carry the weakest word confidence up to the line — a line is only as
    // trustworthy as its least certain word.
    const confidences = line.items.map((i) => i.confidence).filter((c) => typeof c === 'number');
    line.ocrConfidence = confidences.length ? Math.min(...confidences) : null;
  }
  return lines;
}
