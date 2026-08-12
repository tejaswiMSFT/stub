/**
 * Brand identity for Stub.
 *
 * Defined once, in code, so the mark on the landing page, the icon on the home screen
 * and the favicon in the tab are all the same drawing rather than three drifting copies.
 * Everything is generated; there are no binary design assets to keep in step.
 *
 * The mark is a single ticket: a rounded card with four notches and a perforation down
 * the middle, lit from above. Decisions here were arrived at the hard way:
 *
 *   One shape, not a scene. The mark was previously a fanned hand of four tickets with a
 *   QR on the front card. A composition of that kind needs room to be read, and the sizes
 *   that matter most — a 20px app bar, a favicon — do not have it, so it arrived as a
 *   coloured smudge. A silhouette survives any scale, which is why it no longer needs a
 *   simplified variant for small sizes at all.
 *
 *   Four notches, not two. Bites out of the left and right edges alone produce a dented
 *   rectangle; the eye does not see a ticket. Adding small bites at the centre of the top
 *   and bottom edges puts a visible terminus on the tear line, and *that* is what makes
 *   the shape legible — it reads as a ticket about to be torn in half. Measuring a
 *   reference mark is what surfaced this; it is not obvious by eye.
 *
 *   The perforation is capsule slots, not round dots. A circle reads as a hole punched
 *   through the card. An elongated slot reads as a cut, which is what a perforation is.
 *
 *   Every notch arc uses sweep-flag 0. The outline is traversed clockwise, and on that
 *   path sweep 0 curves the arc into the body. Sweep 1 bulges it outward and turns each
 *   bite into a lobe, which silently produces a flower rather than a ticket.
 *
 *   Lit, not extruded or bevelled. A soft highlight down the top third over a diagonal
 *   gradient reads as a solid object catching light. A hard specular streak with a
 *   bevelled edge is skeuomorphism and dates a mark instantly; a stacked extrusion reads
 *   as a printing misregistration once the mark is small.
 */

export const brand = {
  name: 'Stub',
  tagline: 'Your tickets, on your phone.',

  colour: {
    // The mark, and the app's primary colour throughout.
    ink: '#5B4FE8',
    // Lighter and darker stops, for the lit face.
    lift: '#8B7CFF',
    deep: '#4A3DC4',

    /**
     * The tile behind the mark on a home screen.
     *
     * White, not the app's dark surface. A near-black tile made the icon disappear into a
     * dark wallpaper — the mark and the tile were both dark, so only the perforation read
     * from any distance. A light tile carries the indigo on any background, which is why
     * essentially every shipped app icon does this.
     */
    tile: '#ffffff',

    ground: '#1c1c1e',
    paper: '#ffffff',
  },
};

/**
 * Proportions of the ticket, as fractions of its own height.
 *
 * Held together in one place because they are interdependent: enlarging the corner radius
 * without shortening the side notch, for instance, leaves no straight edge between the
 * two and the silhouette turns to mush.
 *
 * These are not estimates. tools/_trace-mark.mjs walks both the reference mark and this
 * one row by row and reports where the ink starts and stops as a fraction of width, which
 * is what finally settled a shape that three rounds of eyeballing had got wrong:
 *
 *   The side notch cuts to 0.157 of the width at its deepest, against 0.130 here — the
 *   bite was visibly shallower, which is what made the shape read as a soft-edged card
 *   rather than a ticket with a piece taken out.
 *
 *   The notch spans t=0.40 to t=0.60 of the height; the corner finishes turning by
 *   t=0.15. Those two match already and are not changed.
 *
 *   Aspect is 1.203, not 1.22.
 */
const SHAPE = {
  ratio: 1.203,
  // The corner inset at the very top and bottom row of the profile: 0.157 of the width in
  // the reference, against 0.125 with an 0.18 radius. A rounder corner is what gives the
  // shape its soft, squircle-like feel rather than a rectangle with the edges knocked off.
  corner: 0.225,
  // Depth and span are separate because the notch is an ellipse, not a circle. As a
  // circle the two were one number, and deepening the bite also stretched it along the
  // edge until it met the corners — so the arc clamped and the depth would not move
  // however large the radius was set.
  //
  // 0.105 is the measured depth at mid-height. An earlier reading of 0.157 was taken from
  // the profile's last row, which is the *corner* inset, not the notch — cutting to that
  // produced a waist far deeper than the reference. Read the middle of the profile for
  // the notch and the ends for the corner; they are different measurements.
  notchDepth: 0.105,
  notchSpan: 0.135,
  edgeNotch: 0.07,
  slots: 4,
  slotWidth: 0.075,
  slotHeight: 0.13,
};

/**
 * The outline, traversed clockwise from the top-left corner.
 *
 * All four notches use sweep-flag 0 — see the note at the top of the file. `w` and `h`
 * are the ticket's own box; the caller positions it.
 *
 * The side notch is an elliptical arc: `notchDepth` is how far it cuts in, measured
 * against the width as the trace reports it, and `notchSpan` is how far it reaches along
 * the edge. Keeping them independent is what finally let the bite match the reference.
 */
function ticketPath({ w, h }) {
  const corner = h * SHAPE.corner;
  const depth = w * SHAPE.notchDepth;
  const span = h * SHAPE.notchSpan;
  const edge = h * SHAPE.edgeNotch;
  const midX = w / 2;
  const midY = h / 2;
  const n = (value) => value.toFixed(2);

  return [
    `M ${n(corner)} 0`,
    `L ${n(midX - edge)} 0`,
    `A ${n(edge)} ${n(edge)} 0 0 0 ${n(midX + edge)} 0`,
    `L ${n(w - corner)} 0`,
    `A ${n(corner)} ${n(corner)} 0 0 1 ${n(w)} ${n(corner)}`,
    `L ${n(w)} ${n(midY - span)}`,
    `A ${n(depth)} ${n(span)} 0 0 0 ${n(w)} ${n(midY + span)}`,
    `L ${n(w)} ${n(h - corner)}`,
    `A ${n(corner)} ${n(corner)} 0 0 1 ${n(w - corner)} ${n(h)}`,
    `L ${n(midX + edge)} ${n(h)}`,
    `A ${n(edge)} ${n(edge)} 0 0 0 ${n(midX - edge)} ${n(h)}`,
    `L ${n(corner)} ${n(h)}`,
    `A ${n(corner)} ${n(corner)} 0 0 1 0 ${n(h - corner)}`,
    `L 0 ${n(midY + span)}`,
    `A ${n(depth)} ${n(span)} 0 0 0 0 ${n(midY - span)}`,
    `L 0 ${n(corner)}`,
    `A ${n(corner)} ${n(corner)} 0 0 1 ${n(corner)} 0`,
    'Z',
  ].join(' ');
}

/**
 * The perforation: capsule slots on the centre line, between the two edge notches.
 *
 * Returned as rects so the caller can either paint them over a filled mark or punch them
 * out through a mask, where whatever lies beneath must show through.
 */
function slots({ w, h, fill }) {
  const sw = h * SHAPE.slotWidth;
  const sh = h * SHAPE.slotHeight;
  const inset = h * SHAPE.edgeNotch + h * 0.05;
  const from = inset;
  const to = h - inset - sh;
  const step = SHAPE.slots > 1 ? (to - from) / (SHAPE.slots - 1) : 0;

  return Array.from({ length: SHAPE.slots }, (unused, i) =>
    `<rect x="${(w / 2 - sw / 2).toFixed(2)}" y="${(from + i * step).toFixed(2)}"
      width="${sw.toFixed(2)}" height="${sh.toFixed(2)}" rx="${(sw / 2).toFixed(2)}" fill="${fill}"/>`).join('');
}

/**
 * Moves a colour towards its opposite by a small amount.
 *
 * Used for the tile's shading, which has to work for a white tile and a dark one: mixing
 * towards black would do nothing visible on a near-black ground. Direction is chosen from
 * the colour's own lightness, so a light tile darkens and a dark tile lifts.
 *
 * Accepts three- or six-digit hex, which is what every colour in this file is.
 */
function shade(hex, amount) {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const value = Number.parseInt(full, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;

  // Rec. 601 luma: good enough to decide which way is "away from this colour".
  const towards = (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? 0 : 255;
  const mix = (channel) => Math.round(channel + (towards - channel) * amount);

  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The mark.
 *
 * `variant`:
 *   'app'   — the mark on its tile, for home screens and favicons
 *   'plain' — the ticket alone in one colour, for use inline with text
 *
 * `colour` applies to the plain variant, which is a single flat silhouette. It is ignored
 * for the app variant: that face is a three-stop gradient built from the brand palette,
 * and a caller passing `currentColor` — as the landing page did — put white into the
 * middle stop and washed the whole mark out. A tile that changes colour with surrounding
 * text is not a thing worth supporting.
 *
 * `bleed` is the margin left around it. Maskable icons need much more, because Android
 * crops to whatever shape a launcher prefers and a mark drawn near the edge loses its
 * corners to a circular mask.
 *
 * `full` is accepted and ignored. It previously forced the elaborate composition at small
 * sizes; there is only one drawing now, so there is nothing to force. The parameter is
 * kept so existing callers continue to work.
 */
export function markSvg({
  size = 512, variant = 'app', bleed = 0.155, colour = null, ground = null, full = null,
} = {}) {
  // Ids must be unique per instance: several marks commonly share one page, and duplicate
  // ids make every later mask and gradient resolve to the first, so only the first draws.
  const uid = `s${Math.random().toString(36).slice(2, 9)}`;
  const plain = variant === 'plain';

  // The mark is drawn large within its tile. An earlier icon sat small inside its own
  // square while every neighbouring app icon filled close to its edges, which made it look
  // timid on a home screen. Bleed is still honoured, for the maskable case.
  const span = plain ? 1 : Math.min(0.78, 1 - bleed * 2);
  const w = size * span;
  const h = w / SHAPE.ratio;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  const at = `translate(${x.toFixed(2)} ${y.toFixed(2)})`;

  const d = ticketPath({ w, h });

  if (plain) {
    // One colour, with the perforation cut through rather than painted, so the mark sits
    // on any background — including coloured chrome and dark mode.
    const ink = colour || 'currentColor';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${brand.name}">
  <defs>
    <mask id="${uid}">
      <rect width="${size}" height="${size}" fill="#000"/>
      <path d="${d}" transform="${at}" fill="#fff"/>
      <g transform="${at}">${slots({ w, h, fill: '#000' })}</g>
    </mask>
  </defs>
  <rect width="${size}" height="${size}" fill="${ink}" mask="url(#${uid})"/>
</svg>`;
  }

  // Deliberately not `colour`. See the note above: the lit face is a brand gradient, and
  // letting a caller substitute the middle stop is what washed the landing mark out.
  const face = brand.colour.ink;
  const tile = ground || brand.colour.tile;
  const radius = (size * 0.225).toFixed(1);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${brand.name}">
  <defs>
    <linearGradient id="${uid}f" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="${brand.colour.lift}"/>
      <stop offset="48%" stop-color="${face}"/>
      <stop offset="100%" stop-color="${brand.colour.deep}"/>
    </linearGradient>
    <linearGradient id="${uid}s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.40"/>
      <stop offset="45%" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>

    <!-- The tile is shaded rather than flat. A flat white square reads as printed on the
         background; a face falling off very slightly towards the bottom reads as a
         physical object catching light from above, which is what every platform's own
         icons do. The range is deliberately narrow — a strong gradient here competes with
         the mark and looks like a button. -->
    <linearGradient id="${uid}t" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0%" stop-color="${tile}"/>
      <stop offset="58%" stop-color="${shade(tile, 0.035)}"/>
      <stop offset="100%" stop-color="${shade(tile, 0.10)}"/>
    </linearGradient>

    <!-- A hairline inside the edge. It separates the tile from a background of a similar
         colour — a white tile on a white page otherwise has no boundary at all — and
         gives the top edge the thin bright line a lit surface has. -->
    <linearGradient id="${uid}e" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="55%" stop-color="${shade(tile, 0.16)}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${shade(tile, 0.26)}" stop-opacity="0.42"/>
    </linearGradient>

    <clipPath id="${uid}c"><path d="${d}" transform="${at}"/></clipPath>
    <!-- The perforation is cut out of the mark rather than painted over it, so the tile
         shows through. Painted white it was invisible the moment the tile turned white,
         and the mark lost the one detail that says "ticket". -->
    <mask id="${uid}m">
      <path d="${d}" transform="${at}" fill="#fff"/>
      <g transform="${at}">${slots({ w, h, fill: '#000' })}</g>
    </mask>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#${uid}t)"/>
  <g mask="url(#${uid}m)">
    <g transform="${at}"><path d="${d}" fill="url(#${uid}f)"/></g>
    <g clip-path="url(#${uid}c)"><rect width="${size}" height="${size}" fill="url(#${uid}s)"/></g>
  </g>
  <rect x="${(size * 0.004).toFixed(2)}" y="${(size * 0.004).toFixed(2)}"
        width="${(size * 0.992).toFixed(2)}" height="${(size * 0.992).toFixed(2)}"
        rx="${radius}" fill="none" stroke="url(#${uid}e)" stroke-width="${(size * 0.008).toFixed(2)}"/>
</svg>`;
}

/**
 * The wordmark: the mark beside the name.
 *
 * Generated together so the two are never separately positioned and cannot drift apart.
 * Tracking is tightened well past the default — at display sizes the system font sets far
 * too loosely to look like a considered logotype rather than a heading.
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
