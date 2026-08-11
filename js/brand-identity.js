/**
 * Brand identity for Stub.
 *
 * Defined once, in code, so the mark on the landing page, the icon on the home screen
 * and the favicon in the tab are all the same drawing rather than three drifting copies.
 * Everything is generated; there are no binary design assets to keep in step.
 *
 * The mark is a fanned hand of tickets, tilted, the front one carrying a QR code.
 * Several decisions here were arrived at the hard way and should not be quietly undone:
 *
 *   The stack is tilted, and the cards fan. Axis-aligned and merely offset, the mark read
 *   as a stack of cards seen flat — correct but inert. The tilt is what gives it life.
 *
 *   Cards fan about a point near the lower-left, not about the centre. Rotated about the
 *   middle they splay at *both* ends and poke out as wedges; a real hand of cards pivots
 *   where it is held.
 *
 *   The front ticket carries a QR. Scanning is what this app does, and no earlier version
 *   of the mark said so. It is drawn as three ringed eyes, because that is what the eye
 *   actually recognises — filled squares merge into blobs and read as a window.
 *
 *   Below 26px the composition is abandoned for a single ticket. The threshold was
 *   originally 44, on the assumption that a tilted fan could not survive smaller; putting
 *   both side by side at every size disproved it, and left the browser tab showing the
 *   real mark while the app's own bar showed a plain one.
 *
 *   Notches sit opposite one another, near one end. Placed mid-edge, the shape reads as
 *   a bag or a basket rather than a ticket. Their position is what makes it legible.
 *
 *   Warm behind cool. Amber, pink and green sit behind the blue because warm behind cool
 *   is the sharpest separation available, and it shows through the notches — which is what
 *   makes them read at all. A cool colour there bleeds into the front card.
 *
 *   Gradients, but soft ones. A hard specular streak with a bevelled edge and a dark
 *   outline is skeuomorphism, and dates a mark instantly. A single soft diagonal across
 *   each face is dimensional without being varnished.
 */

export const brand = {
  name: 'Stub',
  tagline: 'Your tickets, on your phone.',

  colour: {
    // The front ticket, and the app's primary colour throughout.
    ink: '#0a84ff',
    // The cards behind, front to back.
    cards: ['#ff9f0a', '#ff375f', '#00c78c'],
    ground: '#1c1c1e',
    paper: '#ffffff',
  },
};

/**
 * The cards behind the front ticket, nearest first.
 *
 * `lift` is how far each is nudged up, as a fraction of the card's height, so the fan
 * opens upward as well as around.
 */
const FAN = [
  { id: 'b', from: '#ffc247', to: '#ff9500', lift: 0.035, step: 1 },
  { id: 'c', from: '#ff6482', to: '#ff2d55', lift: 0.07, step: 2 },
  { id: 'd', from: '#5ce0b0', to: '#00c78c', lift: 0.105, step: 3 },
];

/**
 * Which card shows through the notches.
 *
 * The notches cut the front ticket, so whatever sits directly behind is what appears in
 * them. That has to be the amber: warm behind cool is the sharpest separation available
 * and is what makes the notches read as cut rather than as smudges. The green is furthest
 * back for the same reason — it is closest in temperature to the blue.
 */

/** How far apart the cards fan, in degrees. */
const SPREAD = 7.5;

/** The tilt of the whole stack. */
const TILT = -13;

/**
 * Below this the full composition is abandoned for a single flat ticket.
 *
 * Set at 44 on the assumption that four rotated cards could not survive smaller. Rendering
 * both side by side at every size from 28 up disproved that: at the 3× density every
 * phone has, the fan and the code still read at 28px, and the simplified drawing is
 * merely blander rather than clearer. It was also visibly inconsistent — the browser tab
 * showed the real mark while the app's own bar showed the plain one, on the same screen.
 *
 * 24 is kept as a floor because at that size the tilt genuinely does turn to porridge.
 */
const SIMPLIFY_BELOW = 26;

/**
 * A QR mark: three ringed eyes and a few loose modules.
 *
 * The rings are the whole trick. A QR is recognised by its finder patterns — a square
 * ring with a gap around it — and drawing them as solid squares instead merges them with
 * their neighbours into four dark blobs that read as a window, not a code.
 *
 * The loose modules are dropped when small, where they only fill in the gaps that make
 * the eyes legible.
 */
function qrGlyph(x, y, size, fill, { detail = true } = {}) {
  const u = size / 7;
  const e = u / 2;

  const ring = (ex, ey) => `<rect x="${(ex).toFixed(2)}" y="${(ey).toFixed(2)}"
    width="${(u * 3).toFixed(2)}" height="${(u * 3).toFixed(2)}" rx="${(u * 0.4).toFixed(2)}"
    fill="none" stroke="${fill}" stroke-width="${u.toFixed(2)}"/>`;

  // Modules are placed, not scattered, and the lower-right quadrant is filled rather than
  // dotted. Two earlier arrangements each left a single module hanging below the
  // top-right eye, and a ring with one dot under it reads unmistakably as a question
  // mark — which is a poor thing for a ticket app's icon to say.
  const cells = detail
    ? [
      [4, 4], [6, 4], [4, 6], [6, 6], [5, 5],
      [3, 1], [3, 3], [3, 5], [1, 3], [5, 3],
    ]
    : [];

  return `<g>
    ${ring(x + e, y + e)}${ring(x + u * 4 + e, y + e)}${ring(x + e, y + u * 4 + e)}
    ${cells.map(([cx, cy]) => `<rect x="${(x + cx * u).toFixed(2)}" y="${(y + cy * u).toFixed(2)}"
      width="${u.toFixed(2)}" height="${u.toFixed(2)}" rx="${(u * 0.18).toFixed(2)}" fill="${fill}"/>`).join('')}
  </g>`;
}

/**
 * One ticket, as a masked shape.
 *
 * The notches and perforation are *cut* rather than drawn over, so they show whatever
 * lies beneath. That is what makes a stack read as separate pieces of card rather than as
 * one shape with a pattern on it.
 *
 * `cut` is off for the cards behind. Cutting every layer at a different angle piled four
 * sets of notches on top of one another and turned the top edge into confetti — and none
 * of it was legible anyway, since only slivers of those cards are visible. Only the front
 * ticket needs to look torn.
 */
function ticketShape({ id, x, y, w, h, r, tear, fill, rotate, cx, cy, cut = true }) {
  const nx = x + w * tear;
  const nr = h * 0.13;
  const dw = w * 0.035;
  const dh = h * 0.11;

  const dashes = [0.17, 0.39, 0.61, 0.83]
    .map((t) => `<rect x="${(nx - dw / 2).toFixed(2)}" y="${(y + h * t - dh / 2).toFixed(2)}"
      width="${dw.toFixed(2)}" height="${dh.toFixed(2)}" rx="${(dw / 2).toFixed(2)}" fill="#000"/>`)
    .join('');

  if (!cut) {
    return {
      mask: '',
      body: `<g transform="rotate(${rotate.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})">
        <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"
              rx="${r.toFixed(2)}" fill="${fill}"/>
      </g>`,
    };
  }

  return {
    mask: `<mask id="m${id}">
      <rect x="${(x - w).toFixed(1)}" y="${(y - h).toFixed(1)}" width="${(w * 3).toFixed(1)}" height="${(h * 3).toFixed(1)}" fill="#000"/>
      <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${r.toFixed(2)}" fill="#fff"/>
      <circle cx="${nx.toFixed(2)}" cy="${y.toFixed(2)}" r="${nr.toFixed(2)}" fill="#000"/>
      <circle cx="${nx.toFixed(2)}" cy="${(y + h).toFixed(2)}" r="${nr.toFixed(2)}" fill="#000"/>
      ${dashes}
    </mask>`,
    body: `<g transform="rotate(${rotate.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})" mask="url(#m${id})">
      <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}"/>
    </g>`,
  };
}

/**
 * The mark.
 *
 * `variant`:
 *   'app'   — the full icon on its tile, for home screens and favicons
 *   'plain' — the ticket alone in one colour, for use inline with text
 *
 * `bleed` is the margin left around it. Maskable icons need much more, because Android
 * crops to whatever shape a launcher prefers and a mark drawn near the edge loses its
 * corners to a circular mask.
 *
 * `full` forces the complete composition regardless of size — needed when rendering an
 * icon file at a small pixel size that will be *displayed* large.
 */
export function markSvg({
  size = 512, variant = 'app', bleed = 0.155, colour = null, ground = null, full = null,
} = {}) {
  // Ids must be unique per instance: several marks commonly share one page, and
  // duplicate ids make every later mask resolve to the first, so only the first draws.
  const uid = `s${Math.random().toString(36).slice(2, 9)}`;

  const plain = variant === 'plain';
  const detailed = full ?? (!plain && size >= SIMPLIFY_BELOW);

  if (!detailed) return simpleMark({ uid, size, plain, bleed, colour, ground });

  // Cards are drawn large within the tile: the earlier mark sat small inside its own
  // square while every neighbouring app icon filled close to its edges, which made it
  // look timid on a home screen.
  //
  // Bleed still has to be honoured, though, because a maskable icon is cropped to
  // whatever shape an Android launcher prefers — usually a circle — and a composition
  // drawn to the edges loses its corners entirely.
  const spanRatio = Math.min(0.84, 1 - bleed * 2);
  const w = size * spanRatio;
  const h = w * 0.66;
  const r = size * 0.05;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const tear = 0.58;

  // Drawn furthest first, so nearer cards paint over further ones. `FAN` is written
  // nearest-first because that is how it reads as a list; painting it in that order put
  // the *green* — the backmost card — on top of the amber, which is why the wrong colour
  // was showing through the notches.
  const behind = [...FAN].reverse().map((card, i) => ticketShape({
    id: `${uid}${i}`,
    x,
    y: y - h * card.lift,
    w,
    h,
    r,
    tear,
    fill: `url(#${uid}${card.id})`,
    // Taken from the card rather than from its index, which flipped when the draw order
    // was reversed and quietly turned the fan inside out.
    rotate: TILT + SPREAD * card.step,
    cx,
    cy,
    cut: false,
  }));

  const front = ticketShape({
    id: `${uid}f`, x, y, w, h, r, tear, fill: `url(#${uid}a)`, rotate: TILT, cx, cy,
  });

  // The code sits centred in the larger panel, left of the tear, and turns with the
  // ticket — it is printed on the card, so it rotates with it.
  const panel = w * tear;
  const codeSize = Math.min(h * 0.66, panel * 0.62);
  const codeX = x + (panel - codeSize) / 2;
  const codeY = y + (h - codeSize) / 2;

  const gradients = [
    `<linearGradient id="${uid}a" x1="0" y1="0" x2="0.55" y2="1">
      <stop offset="0%" stop-color="#4aa8ff"/><stop offset="52%" stop-color="#0a84ff"/>
      <stop offset="100%" stop-color="#0060df"/></linearGradient>`,
    ...FAN.map((c) => `<linearGradient id="${uid}${c.id}" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="${c.from}"/><stop offset="100%" stop-color="${c.to}"/></linearGradient>`),
    `<linearGradient id="${uid}t" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2c2c30"/><stop offset="100%" stop-color="#0e0e10"/></linearGradient>`,
  ].join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${brand.name}">
  <defs>
    ${gradients}
    ${behind.map((t) => t.mask).join('')}
    ${front.mask}
  </defs>
  ${plain ? '' : `<rect width="${size}" height="${size}" rx="${(size * 0.225).toFixed(1)}" fill="${ground ? `"${ground}"` : `url(#${uid}t)`}"/>`}
  ${behind.map((t) => t.body).join('')}
  ${front.body}
  <g transform="rotate(${TILT} ${cx.toFixed(1)} ${cy.toFixed(1)})">
    ${qrGlyph(codeX, codeY, codeSize, 'rgba(0,22,50,0.82)', { detail: size >= 64 })}
  </g>
</svg>`;
}

/**
 * The small drawing: one ticket, flat, no code.
 *
 * Used below 44px and for the inline variant. At those sizes the fan is a smudge and the
 * QR's eyes close up, so this keeps only what still reads — the silhouette, the notches
 * and the perforation.
 */
function simpleMark({ uid, size, plain, bleed, colour, ground }) {
  const p = size * bleed;
  const w = (size - p * 2) * (plain ? 1 : 0.88);
  const h = w * 0.66;
  const r = size * 0.055;
  const x = plain ? (size - w) / 2 : (size - w) / 2;
  const y = (size - h) / 2;

  const nx = x + w * 0.62;
  const nr = h * 0.13;
  const dw = Math.max(size * 0.02, w * 0.042);
  const dh = h * 0.12;

  const dashes = [0.18, 0.41, 0.64, 0.87]
    .map((t) => `<rect x="${(nx - dw / 2).toFixed(2)}" y="${(y + h * t - dh / 2).toFixed(2)}"
      width="${dw.toFixed(2)}" height="${dh.toFixed(2)}" rx="${(dw / 2).toFixed(2)}" fill="#000"/>`)
    .join('');

  const front = plain ? (colour || 'currentColor') : brand.colour.ink;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${brand.name}">
  <defs>
    <mask id="${uid}">
      <rect width="${size}" height="${size}" fill="#000"/>
      <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${r.toFixed(2)}" fill="#fff"/>
      <circle cx="${nx.toFixed(2)}" cy="${y.toFixed(2)}" r="${nr.toFixed(2)}" fill="#000"/>
      <circle cx="${nx.toFixed(2)}" cy="${(y + h).toFixed(2)}" r="${nr.toFixed(2)}" fill="#000"/>
      ${dashes}
    </mask>
  </defs>
  ${plain ? '' : `<rect width="${size}" height="${size}" rx="${(size * 0.225).toFixed(1)}" fill="${ground || brand.colour.ground}"/>`}
  ${plain ? '' : `<rect x="${(x + size * 0.022).toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${r.toFixed(2)}" fill="${brand.colour.cards[0]}"/>`}
  <rect width="${size}" height="${size}" fill="${front}" mask="url(#${uid})"/>
</svg>`;
}

/**
 * The wordmark: the mark beside the name.
 *
 * Generated together so the two are never separately positioned and cannot drift apart.
 * Tracking is tightened well past the default — at display sizes the system font sets
 * far too loosely to look like a considered logotype rather than a heading.
 */
export function wordmarkSvg({ height = 40, colour = 'currentColor', variant = 'app' } = {}) {
  const markSize = height * 1.06;
  const gap = height * 0.26;
  const fontSize = height * 0.86;
  const textWidth = fontSize * 2.18;
  const width = markSize + gap + textWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height}"
     viewBox="0 0 ${width.toFixed(0)} ${height}" role="img" aria-label="${brand.name}">
  <g transform="translate(0, ${((height - markSize) / 2).toFixed(1)})">
    ${markSvg({
    size: markSize,
    variant,
    bleed: variant === 'plain' ? 0.02 : 0.06,
    colour,
    // The wordmark is a display asset — it appears on the landing page and in Settings
    // at a size where the full composition reads — so it is forced rather than left to
    // the size threshold, which is meant for chrome.
    full: variant !== 'plain',
  })}
  </g>
  <text x="${(markSize + gap).toFixed(1)}" y="${(height * 0.72).toFixed(1)}"
        font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif"
        font-size="${fontSize.toFixed(1)}" font-weight="680"
        letter-spacing="${(-fontSize * 0.035).toFixed(2)}"
        fill="${colour}">${brand.name}</text>
</svg>`;
}

/** Data URL, for an img src or a favicon link. */
export function svgUrl(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
