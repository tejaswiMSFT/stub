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
 * The side notches are shallower than the reference mark's, and the slots wider. Drawn to
 * the reference proportions the mark was correct at display size but pinched at the waist
 * by 20px, where it read as a bowtie rather than a ticket, and the perforation closed up
 * into an invisible hairline. Widening the cut and easing the bite costs nothing large
 * and is the difference between legible and not small.
 */
const SHAPE = {
  ratio: 1.22,
  corner: 0.18,
  sideNotch: 0.105,
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
 */
function ticketPath({ w, h }) {
  const corner = h * SHAPE.corner;
  const side = h * SHAPE.sideNotch;
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
    `L ${n(w)} ${n(midY - side)}`,
    `A ${n(side)} ${n(side)} 0 0 0 ${n(w)} ${n(midY + side)}`,
    `L ${n(w)} ${n(h - corner)}`,
    `A ${n(corner)} ${n(corner)} 0 0 1 ${n(w - corner)} ${n(h)}`,
    `L ${n(midX + edge)} ${n(h)}`,
    `A ${n(edge)} ${n(edge)} 0 0 0 ${n(midX - edge)} ${n(h)}`,
    `L ${n(corner)} ${n(h)}`,
    `A ${n(corner)} ${n(corner)} 0 0 1 0 ${n(h - corner)}`,
    `L 0 ${n(midY + side)}`,
    `A ${n(side)} ${n(side)} 0 0 0 0 ${n(midY - side)}`,
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
 * The mark.
 *
 * `variant`:
 *   'app'   — the mark on its tile, for home screens and favicons
 *   'plain' — the ticket alone in one colour, for use inline with text
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

  const face = colour || brand.colour.ink;
  const tile = ground || brand.colour.ground;

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
    <clipPath id="${uid}c"><path d="${d}" transform="${at}"/></clipPath>
  </defs>
  <rect width="${size}" height="${size}" rx="${(size * 0.225).toFixed(1)}" fill="${tile}"/>
  <g transform="${at}"><path d="${d}" fill="url(#${uid}f)"/></g>
  <g clip-path="url(#${uid}c)"><rect width="${size}" height="${size}" fill="url(#${uid}s)"/></g>
  <g transform="${at}">${slots({ w, h, fill: brand.colour.paper })}</g>
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
