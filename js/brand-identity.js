/**
 * Brand identity for Stub.
 *
 * Defined once, in code, so the mark on the landing page, the icon on the home screen
 * and the favicon in the tab are all the same drawing rather than three drifting copies.
 * Everything is generated; there are no binary design assets to keep in step.
 *
 * The mark is a wallet of tickets: four cards fanned to the right, the front one a
 * ticket with notches and a perforation. Several decisions here were arrived at the hard
 * way and should not be quietly undone:
 *
 *   Solid colours, never translucent. Layering semi-transparent whites piles into an
 *   out-of-focus mush at small sizes — Apple, Google and Samsung all use flat opaque
 *   colour, which is exactly why their icons stay crisp.
 *
 *   Notches sit opposite one another, near one end. Placed mid-edge, the shape reads as
 *   a bag or a basket rather than a ticket. Their position is what makes it legible.
 *
 *   No torn edge. A jagged tear was the original idea and looks unsettling rather than
 *   charming once shrunk — the notches carry the meaning perfectly well alone.
 *
 *   Amber sits immediately behind the blue. Warm behind cool is the sharpest separation
 *   available, and it shows through the notches, which is what makes them read. A cool
 *   colour there (teal, indigo) bleeds into the front card and the edge disappears.
 *
 *   Four cards, no more. Every extra card steals contrast and space from the ticket's
 *   own details, and past four they compress into a stripe.
 */

export const brand = {
  name: 'Stub',
  tagline: 'Your tickets, on your phone.',

  colour: {
    // The front ticket, and the app's primary colour throughout.
    ink: '#0a84ff',
    // The cards behind, front to back.
    cards: ['#40c8e0', '#ff375f', '#ff9f0a'],
    ground: '#1c1c1e',
    paper: '#ffffff',
  },
};

/** Card order back-to-front, with the ticket last. */
const STACK = ['#ff375f', '#40c8e0', '#ff9f0a', brand.colour.ink];

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
 */
export function markSvg({ size = 512, variant = 'app', bleed = 0.155, colour = null, ground = null } = {}) {
  // Ids must be unique per instance: several marks commonly share one page, and
  // duplicate ids make every later mask resolve to the first, so only the first draws.
  const uid = `s${Math.random().toString(36).slice(2, 9)}`;

  const plain = variant === 'plain';
  const p = size * bleed;
  const w = (size - p * 2) * (plain ? 1 : 0.84);
  const h = w * 0.66;
  const r = size * 0.05;
  const x = plain ? (size - w) / 2 : p;
  const y = (size - h) / 2;

  const gap = size * 0.034;
  const front = plain ? (colour || 'currentColor') : STACK[STACK.length - 1];

  const behind = plain ? '' : STACK.slice(0, -1).map((fill, i) => {
    const depth = STACK.length - 1 - i;
    return `<rect x="${(x + gap * depth).toFixed(1)}" y="${y.toFixed(1)}"
      width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${r.toFixed(1)}" fill="${fill}"/>`;
  }).join('');

  // The stub line: notches opposite one another, with the perforation between them.
  const nx = x + w * 0.68;
  const nr = h * 0.16;
  const dw = size * 0.022;
  const dh = h * 0.12;
  const dashes = [0.125, 0.375, 0.625, 0.875]
    .map((t) => `<rect x="${(nx - dw / 2).toFixed(1)}" y="${(y + h * t - dh / 2).toFixed(1)}"
        width="${dw.toFixed(1)}" height="${dh.toFixed(1)}" rx="${(dw / 2).toFixed(1)}" fill="#000"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${brand.name}">
  <defs>
    <mask id="${uid}">
      <rect width="${size}" height="${size}" fill="#000"/>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${r.toFixed(1)}" fill="#fff"/>
      <circle cx="${nx.toFixed(1)}" cy="${y.toFixed(1)}" r="${nr.toFixed(1)}" fill="#000"/>
      <circle cx="${nx.toFixed(1)}" cy="${(y + h).toFixed(1)}" r="${nr.toFixed(1)}" fill="#000"/>
      ${dashes}
    </mask>
  </defs>
  ${plain ? '' : `<rect width="${size}" height="${size}" rx="${(size * 0.225).toFixed(1)}" fill="${ground || brand.colour.ground}"/>`}
  ${behind}
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
    ${markSvg({ size: markSize, variant, bleed: variant === 'plain' ? 0.02 : 0.06, colour })}
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
