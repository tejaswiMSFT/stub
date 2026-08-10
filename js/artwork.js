/**
 * Pass artwork.
 *
 * Wallet passes look home-made when they carry no imagery, and downloading imagery
 * would break the one promise this tool makes — that nothing leaves the device. So the
 * artwork is *drawn*, in the browser, from the ticket's own content: an SVG composed
 * to the exact aspect ratio Apple expects, then rasterised to PNG at each scale.
 *
 * Two constraints shape everything here.
 *
 * First, the strip is a **letterbox** — 375×123, roughly 3:1. Portrait imagery such as
 * a film poster crops to an unreadable band, which is why Apple's own cinema passes use
 * a banner instead. Every composition below is designed for that ratio natively.
 *
 * Second, the artwork sits *behind* the pass's own text. Anything busy or high-contrast
 * in the centre makes the seat number unreadable, and a pass you cannot read at the door
 * has failed at its only job. Detail is therefore kept to the edges, and a scrim is laid
 * under the text region.
 */

import { createCanvas as makeCanvas } from './canvas.js';

/**
 * Apple's image slots, at 1x. The 2x and 3x variants are these multiplied — Wallet
 * picks per device, and omitting them yields visibly soft artwork on every modern phone.
 */
export const IMAGE_SLOTS = {
  strip: { width: 375, height: 123 },
  background: { width: 180, height: 220 },
  thumbnail: { width: 90, height: 90 },
  logo: { width: 160, height: 50 },
  icon: { width: 29, height: 29 },
  footer: { width: 286, height: 15 },
};

export const SCALES = [1, 2, 3];

/**
 * Styles whose layout includes a strip image, per Apple's own table.
 *
 * `generic` is absent deliberately — it supports only logo, icon and thumbnail, and a
 * strip handed to it is discarded silently.
 */
export const STRIP_STYLES = new Set(['eventTicket', 'coupon', 'storeCard']);

// ────────────────────────────── colour ──────────────────────────────

/**
 * A small deterministic hash of the ticket's title.
 *
 * Determinism matters more than it appears: the same film must always produce the same
 * artwork, or a user regenerating a pass gets a different-looking one and reasonably
 * wonders whether something went wrong.
 */
function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

export function parseHex(hex) {
  const clean = String(hex || '').trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
}

/** Relative luminance, per WCAG. Used to keep text legible over whatever we draw. */
export function luminance([r, g, b]) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Base hues chosen to suit each category's mood rather than assigned arbitrarily. */
const CATEGORY_HUE = {
  movie: 250,      // indigo — a darkened auditorium lit only by the screen
  concert: 282,    // violet — stage lighting
  theatre: 350,    // crimson — velvet drapes
  sport: 142,      // green — the pitch
  conference: 214, // blue — corporate, unfussy
  cafe: 24,        // roasted brown
  retail: 200,
  event: 232,
  rail: 32,        // amber — distinct from the blue of air travel at a glance
  bus: 158,        // green — the livery of most state road transport corporations
  flight: 210,     // blue — sky
  lodging: 18,     // warm ochre — a lamp left on in a window
  generic: 220,    // muted blue-grey — deliberately unremarkable, since a generic pass
                   // is one we could not identify and should not dress up
};

/**
 * Builds the palette.
 *
 * A colour lifted from the operator's own logo is used when we have one, since matching
 * the brand is what makes the pass feel official. Otherwise the hue comes from the
 * category and only the shade varies with the title — so every cinema ticket is
 * recognisably a cinema ticket, while no two look identical.
 */
export function derivePalette({ category = 'event', title = '', seedColor = null } = {}) {
  const seed = hash(`${category}:${title}`);

  let hue;
  let saturation;
  let lightness;

  const fromLogo = parseHex(seedColor);
  if (fromLogo) {
    const [r, g, b] = fromLogo.map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    lightness = (max + min) / 2;
    saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

    if (delta === 0) hue = CATEGORY_HUE[category] ?? 232;
    else if (max === r) hue = ((g - b) / delta % 6) * 60;
    else if (max === g) hue = ((b - r) / delta + 2) * 60;
    else hue = ((r - g) / delta + 4) * 60;
    if (hue < 0) hue += 360;

    // A brand colour is honoured for hue but forced into a range that stays legible.
    // Airline yellows and cinema oranges are lovely on a website and unreadable behind
    // white pass text.
    saturation = Math.min(Math.max(saturation, 0.35), 0.72);
    lightness = Math.min(Math.max(lightness, 0.16), 0.34);
  } else {
    hue = (CATEGORY_HUE[category] ?? 232) + ((seed % 21) - 10);
    saturation = 0.42 + ((seed >> 5) % 18) / 100;
    lightness = 0.19 + ((seed >> 9) % 9) / 100;
  }

  const base = hslToRgb((hue + 360) % 360, saturation, lightness);
  const deep = hslToRgb((hue + 360) % 360, Math.min(saturation + 0.08, 0.85), Math.max(lightness - 0.09, 0.06));
  const lift = hslToRgb((hue + 18) % 360, Math.min(saturation + 0.14, 0.9), Math.min(lightness + 0.22, 0.62));
  const accent = hslToRgb((hue + 32) % 360, 0.68, 0.66);

  // Foreground is chosen, not assumed. An auto-derived palette that renders the seat
  // number illegible is a genuine failure, so contrast decides this rather than taste.
  const white = [255, 255, 255];
  const black = [17, 17, 17];
  const foreground = contrastRatio(base, white) >= contrastRatio(base, black) ? white : black;

  return {
    background: rgbToHex(base),
    deep: rgbToHex(deep),
    lift: rgbToHex(lift),
    accent: rgbToHex(accent),
    foreground: rgbToHex(foreground),
    label: rgbToHex(foreground.map((v, i) => v * 0.72 + base[i] * 0.28)),
    contrast: Number(contrastRatio(base, foreground).toFixed(2)),
    seed,
  };
}

// ────────────────────────────── compositions ──────────────────────────────

/**
 * Cinema: a curtained proscenium framing a lit screen.
 *
 * The curtains are pushed to the outer thirds deliberately — that is where the strip
 * has room, and it leaves the centre calm enough for the pass's own text to sit over.
 */
/**
 * Cinema: a projection beam crossing a dark auditorium onto a wide screen, edged with
 * film perforations.
 *
 * Curtains were removed deliberately. Drapes are theatre's visual language, and while
 * cinemas have them too, using them in both places made the two passes indistinguishable
 * at a glance — which defeats the point of having artwork at all. Cinema instead gets
 * what only cinema has: a projected beam, a 2.39:1 screen and sprocket holes.
 *
 * The screen sits low and wide rather than centred, because Wallet draws the pass's own
 * text across the middle of the strip and a bright rectangle directly behind it fights
 * for attention with the seat number.
 */
function movieStrip({ width, height, palette, seed }) {
  // Film perforations along the top and bottom edges — the one motif that reads as
  // "cinema" instantly and at any size.
  const perfs = [];
  const perfW = width * 0.026;
  const perfGap = perfW * 1.85;
  const perfH = height * 0.1;
  for (let x = perfGap * 0.5; x < width - perfW; x += perfGap) {
    perfs.push(
      `<rect x="${x.toFixed(1)}" y="${(height * 0.045).toFixed(1)}" width="${perfW.toFixed(1)}" height="${perfH.toFixed(1)}" rx="${(perfW * 0.28).toFixed(1)}" fill="#000" opacity="0.42"/>` +
      `<rect x="${x.toFixed(1)}" y="${(height - height * 0.045 - perfH).toFixed(1)}" width="${perfW.toFixed(1)}" height="${perfH.toFixed(1)}" rx="${(perfW * 0.28).toFixed(1)}" fill="#000" opacity="0.42"/>`
    );
  }

  // The beam leaves a projection port high on the right and widens across the frame.
  const portX = width * 0.88;
  const portY = height * 0.2;
  const screenX = width * 0.08;
  const screenY = height * 0.3;
  const screenW = width * 0.46;
  const screenH = screenW / 2.39;

  // A faint dust-mote shimmer inside the beam, seeded so a given film always matches.
  const motes = [];
  for (let i = 0; i < 7; i++) {
    const t = ((seed >> (i * 2)) % 100) / 100;
    const x = portX - t * (portX - screenX);
    const y = portY + t * (screenY + screenH * 0.5 - portY) + (((seed >> i) % 9) - 4);
    motes.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.7 + (i % 3) * 0.35).toFixed(1)}" fill="${palette.lift}" opacity="0.32"/>`);
  }

  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${palette.deep}"/>
        <stop offset="55%" stop-color="${palette.background}"/>
        <stop offset="100%" stop-color="${palette.deep}"/>
      </linearGradient>
      <linearGradient id="beam" x1="1" y1="0" x2="0" y2="0">
        <stop offset="0%" stop-color="${palette.lift}" stop-opacity="0.42"/>
        <stop offset="100%" stop-color="${palette.lift}" stop-opacity="0.06"/>
      </linearGradient>
      <linearGradient id="screen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${palette.lift}" stop-opacity="0.62"/>
        <stop offset="100%" stop-color="${palette.lift}" stop-opacity="0.24"/>
      </linearGradient>
      <radialGradient id="spill" cx="${((screenX + screenW / 2) / width * 100).toFixed(0)}%" cy="${((screenY + screenH / 2) / height * 100).toFixed(0)}%" r="58%">
        <stop offset="0%" stop-color="${palette.lift}" stop-opacity="0.34"/>
        <stop offset="100%" stop-color="${palette.lift}" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <rect width="${width}" height="${height}" fill="url(#bg)"/>

    <!-- Beam: a narrow port opening out to the full height of the screen. -->
    <polygon points="${portX.toFixed(1)},${portY.toFixed(1)}
                     ${portX.toFixed(1)},${(portY + height * 0.07).toFixed(1)}
                     ${screenX.toFixed(1)},${(screenY + screenH).toFixed(1)}
                     ${screenX.toFixed(1)},${screenY.toFixed(1)}"
             fill="url(#beam)"/>
    ${motes.join('')}

    <rect width="${width}" height="${height}" fill="url(#spill)"/>

    <!-- The screen itself, in cinemascope proportions. -->
    <rect x="${screenX.toFixed(1)}" y="${screenY.toFixed(1)}" width="${screenW.toFixed(1)}" height="${screenH.toFixed(1)}"
          rx="1.5" fill="url(#screen)"/>
    <rect x="${screenX.toFixed(1)}" y="${screenY.toFixed(1)}" width="${screenW.toFixed(1)}" height="${screenH.toFixed(1)}"
          rx="1.5" fill="none" stroke="${palette.accent}" stroke-opacity="0.55" stroke-width="1"/>

    <!-- Projection port. -->
    <rect x="${(portX - 2).toFixed(1)}" y="${(portY - 1).toFixed(1)}" width="${(width * 0.05).toFixed(1)}" height="${(height * 0.11).toFixed(1)}"
          rx="1" fill="${palette.lift}" opacity="0.5"/>

    <g>${perfs.join('')}</g>
  `;
}

/** Concert: a stage rig throwing light down over a crowd silhouette. */
function concertStrip({ width, height, palette, seed }) {
  const beams = [];
  for (let i = 0; i < 5; i++) {
    const x = width * (0.12 + i * 0.19);
    const spread = 26 + ((seed >> (i * 2)) % 18);
    beams.push(
      `<polygon points="${x},0 ${x - spread},${height} ${x + spread},${height}" fill="url(#beam)" opacity="0.5"/>`
    );
  }

  const crowd = [];
  for (let i = 0; i < 46; i++) {
    const x = (i / 46) * width + ((seed >> (i % 12)) % 7);
    const r = 4 + ((seed >> (i % 9)) % 4);
    crowd.push(`<circle cx="${x.toFixed(1)}" cy="${(height - 4).toFixed(1)}" r="${r}" fill="#000" opacity="0.5"/>`);
  }

  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${palette.deep}"/>
        <stop offset="60%" stop-color="${palette.background}"/>
        <stop offset="100%" stop-color="${palette.deep}"/>
      </linearGradient>
      <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${palette.lift}" stop-opacity="0.75"/>
        <stop offset="100%" stop-color="${palette.accent}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    ${beams.join('')}
    <rect x="0" y="0" width="${width}" height="${height * 0.1}" fill="#000" opacity="0.35"/>
    ${crowd.join('')}
  `;
}

/** Theatre: swagged drapes tied back either side, framing a lit stage. */
function theatreStrip({ width, height, palette }) {
  const drapeW = width * 0.3;

  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${palette.deep}"/>
        <stop offset="70%" stop-color="${palette.background}"/>
        <stop offset="100%" stop-color="${palette.deep}"/>
      </linearGradient>
      <radialGradient id="stage" cx="50%" cy="86%" r="46%">
        <stop offset="0%" stop-color="${palette.lift}" stop-opacity="0.46"/>
        <stop offset="100%" stop-color="${palette.lift}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="drape" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${palette.deep}"/>
        <stop offset="100%" stop-color="${palette.background}"/>
      </linearGradient>
      <linearGradient id="pelmet" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${palette.background}"/>
        <stop offset="100%" stop-color="${palette.deep}"/>
      </linearGradient>
    </defs>

    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#stage)"/>

    <!-- Stage floor, to give the light something to fall on. -->
    <rect x="0" y="${height * 0.88}" width="${width}" height="${height * 0.12}"
          fill="${palette.deep}" opacity="0.55"/>
    <rect x="0" y="${height * 0.88}" width="${width}" height="1" fill="${palette.accent}" opacity="0.5"/>

    <!-- Left drape, tied back at mid-height. -->
    <g>
      <path d="M0 0 h${drapeW * 0.9}
               C${(drapeW * 0.75).toFixed(1)} ${(height * 0.3).toFixed(1)}
                ${(drapeW * 0.5).toFixed(1)} ${(height * 0.42).toFixed(1)}
                ${(drapeW * 0.34).toFixed(1)} ${(height * 0.55).toFixed(1)}
               C${(drapeW * 0.55).toFixed(1)} ${(height * 0.72).toFixed(1)}
                ${(drapeW * 0.72).toFixed(1)} ${(height * 0.88).toFixed(1)}
                ${(drapeW * 0.8).toFixed(1)} ${height}
               L0 ${height} Z"
            fill="url(#drape)"/>
      <ellipse cx="${(drapeW * 0.36).toFixed(1)}" cy="${(height * 0.55).toFixed(1)}"
               rx="${(drapeW * 0.09).toFixed(1)}" ry="${(height * 0.05).toFixed(1)}"
               fill="${palette.accent}" opacity="0.55"/>
    </g>

    <!-- Right drape mirrors the left exactly. -->
    <g transform="translate(${width}, 0) scale(-1, 1)">
      <path d="M0 0 h${drapeW * 0.9}
               C${(drapeW * 0.75).toFixed(1)} ${(height * 0.3).toFixed(1)}
                ${(drapeW * 0.5).toFixed(1)} ${(height * 0.42).toFixed(1)}
                ${(drapeW * 0.34).toFixed(1)} ${(height * 0.55).toFixed(1)}
               C${(drapeW * 0.55).toFixed(1)} ${(height * 0.72).toFixed(1)}
                ${(drapeW * 0.72).toFixed(1)} ${(height * 0.88).toFixed(1)}
                ${(drapeW * 0.8).toFixed(1)} ${height}
               L0 ${height} Z"
            fill="url(#drape)"/>
      <ellipse cx="${(drapeW * 0.36).toFixed(1)}" cy="${(height * 0.55).toFixed(1)}"
               rx="${(drapeW * 0.09).toFixed(1)}" ry="${(height * 0.05).toFixed(1)}"
               fill="${palette.accent}" opacity="0.55"/>
    </g>

    <!-- Pelmet across the top, scalloped. -->
    <path d="M0 0 h${width} v${(height * 0.13).toFixed(1)}
             q${(-width * 0.125).toFixed(1)} ${(height * 0.1).toFixed(1)} ${(-width * 0.25).toFixed(1)} 0
             q${(-width * 0.125).toFixed(1)} ${(height * 0.1).toFixed(1)} ${(-width * 0.25).toFixed(1)} 0
             q${(-width * 0.125).toFixed(1)} ${(height * 0.1).toFixed(1)} ${(-width * 0.25).toFixed(1)} 0
             q${(-width * 0.125).toFixed(1)} ${(height * 0.1).toFixed(1)} ${(-width * 0.25).toFixed(1)} 0 Z"
          fill="url(#pelmet)"/>
  `;
}

/** Sport: a pitch, viewed at an angle, with floodlight wash. */
function sportStrip({ width, height, palette }) {
  const stripes = [];
  for (let i = 0; i < 9; i++) {
    if (i % 2) continue;
    stripes.push(`<rect x="${(i / 9) * width}" y="0" width="${width / 9}" height="${height}" fill="#fff" opacity="0.05"/>`);
  }
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${palette.background}"/>
        <stop offset="100%" stop-color="${palette.deep}"/>
      </linearGradient>
      <radialGradient id="flood" cx="50%" cy="0%" r="70%">
        <stop offset="0%" stop-color="#fff" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    ${stripes.join('')}
    <rect width="${width}" height="${height}" fill="url(#flood)"/>
    <circle cx="${width / 2}" cy="${height / 2}" r="${height * 0.3}" fill="none"
            stroke="#fff" stroke-opacity="0.22" stroke-width="1.5"/>
    <line x1="${width / 2}" y1="0" x2="${width / 2}" y2="${height}" stroke="#fff" stroke-opacity="0.22" stroke-width="1.5"/>
  `;
}

/** Conference: restrained geometry. Anything more would look unserious on a badge. */
function conferenceStrip({ width, height, palette, seed }) {
  const shapes = [];
  for (let i = 0; i < 12; i++) {
    const x = ((seed >> (i % 10)) % width);
    const y = ((seed >> (i % 7)) % height);
    const size = 10 + ((seed >> i) % 26);
    shapes.push(
      `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="2" fill="#fff"
             opacity="0.05" transform="rotate(${(seed >> i) % 45} ${x + size / 2} ${y + size / 2})"/>`
    );
  }
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${palette.deep}"/>
        <stop offset="100%" stop-color="${palette.background}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    ${shapes.join('')}
    <rect x="0" y="${height - 2}" width="${width}" height="2" fill="${palette.accent}" opacity="0.7"/>
  `;
}

/** Generic: a soft gradient wash. Neutral by design — no false specificity. */
function genericStrip({ width, height, palette }) {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${palette.background}"/>
        <stop offset="100%" stop-color="${palette.deep}"/>
      </linearGradient>
      <radialGradient id="glow" cx="20%" cy="30%" r="70%">
        <stop offset="0%" stop-color="${palette.lift}" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="${palette.lift}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#glow)"/>
  `;
}

/** Café and retail: a cup and saucer, steam rising, over scattered beans. */
function cafeStrip({ width, height, palette, seed }) {
  const beans = [];
  for (let i = 0; i < 16; i++) {
    const x = ((seed >> (i % 9)) % width);
    const y = ((seed >> (i % 6)) % height);
    const r = 3 + ((seed >> i) % 3);
    beans.push(
      `<g transform="rotate(${(seed >> i) % 90} ${x} ${y})" opacity="0.08">
         <ellipse cx="${x}" cy="${y}" rx="${(r * 1.5).toFixed(1)}" ry="${r}" fill="#000"/>
         <path d="M${x - r * 1.5} ${y} q${r * 1.5} ${-r * 0.7} ${r * 3} 0" fill="none"
               stroke="${palette.lift}" stroke-width="0.7" opacity="0.5"/>
       </g>`
    );
  }

  // Cup geometry, derived once so every part stays in proportion.
  const cx = width * 0.5;
  const rimY = height * 0.36;
  const rimRx = height * 0.20;
  const rimRy = height * 0.055;
  const bodyH = height * 0.30;
  const baseRx = rimRx * 0.66;
  const saucerY = rimY + bodyH + height * 0.035;

  const steam = [];
  for (let i = 0; i < 3; i++) {
    const x = cx + (i - 1) * (rimRx * 0.62);
    const lean = ((seed >> (i * 4)) % 5) - 2;
    const amp = 4.5 + (i === 1 ? 1.5 : 0);
    const top = rimY - height * 0.30 - (i === 1 ? height * 0.05 : 0);
    steam.push(
      `<path d="M${x.toFixed(1)} ${(rimY - height * 0.05).toFixed(1)}
                C${(x + amp + lean).toFixed(1)} ${(rimY - height * 0.14).toFixed(1)}
                 ${(x - amp + lean).toFixed(1)} ${(rimY - height * 0.19).toFixed(1)}
                 ${(x + lean * 0.5).toFixed(1)} ${top.toFixed(1)}"
             fill="none" stroke="#fff" stroke-opacity="${i === 1 ? 0.26 : 0.17}"
             stroke-width="2" stroke-linecap="round"/>`
    );
  }

  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${palette.background}"/>
        <stop offset="100%" stop-color="${palette.deep}"/>
      </linearGradient>
      <radialGradient id="warm" cx="50%" cy="52%" r="50%">
        <stop offset="0%" stop-color="${palette.lift}" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="${palette.lift}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="porcelain" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#fff" stop-opacity="0.14"/>
        <stop offset="42%" stop-color="#fff" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0.10"/>
      </linearGradient>
    </defs>

    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    ${beans.join('')}
    <rect width="${width}" height="${height}" fill="url(#warm)"/>
    ${steam.join('')}

    <!-- Handle sits behind the body so the join is hidden, as it would be in life. -->
    <path d="M${(cx + rimRx * 0.9).toFixed(1)} ${(rimY + bodyH * 0.22).toFixed(1)}
             a${(bodyH * 0.34).toFixed(1)} ${(bodyH * 0.30).toFixed(1)} 0 0 1 0 ${(bodyH * 0.52).toFixed(1)}"
          fill="none" stroke="#fff" stroke-opacity="0.26" stroke-width="${(height * 0.045).toFixed(1)}"
          stroke-linecap="round"/>

    <path d="M${(cx - rimRx).toFixed(1)} ${rimY.toFixed(1)}
             L${(cx - baseRx).toFixed(1)} ${(rimY + bodyH).toFixed(1)}
             a${baseRx.toFixed(1)} ${(rimRy * 0.8).toFixed(1)} 0 0 0 ${(baseRx * 2).toFixed(1)} 0
             L${(cx + rimRx).toFixed(1)} ${rimY.toFixed(1)} Z"
          fill="url(#porcelain)"/>

    <ellipse cx="${cx}" cy="${rimY.toFixed(1)}" rx="${rimRx.toFixed(1)}" ry="${rimRy.toFixed(1)}"
             fill="#fff" opacity="0.40"/>
    <ellipse cx="${cx}" cy="${rimY.toFixed(1)}" rx="${(rimRx * 0.84).toFixed(1)}" ry="${(rimRy * 0.78).toFixed(1)}"
             fill="${palette.deep}" opacity="0.75"/>

    <ellipse cx="${cx}" cy="${saucerY.toFixed(1)}" rx="${(rimRx * 1.42).toFixed(1)}" ry="${(rimRy * 0.85).toFixed(1)}"
             fill="#fff" opacity="0.22"/>
  `;
}

const COMPOSITIONS = {
  movie: movieStrip,
  concert: concertStrip,
  theatre: theatreStrip,
  sport: sportStrip,
  conference: conferenceStrip,
  cafe: cafeStrip,
  retail: cafeStrip,
  event: genericStrip,
};

/**
 * The footer slot, all a boarding pass gets: 286×15.
 *
 * At fifteen pixels tall nothing representational survives, so this is a hairline rule
 * with a gradient — a finishing touch, not a picture. Attempting an aeroplane here
 * would produce a smudge, and Wallet already draws its own transit glyph between the
 * origin and destination.
 */
function footerArt({ width, height, palette }) {
  return `
    <defs>
      <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${palette.accent}" stop-opacity="0"/>
        <stop offset="50%" stop-color="${palette.accent}" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="${palette.accent}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${height / 2 - 0.5}" width="${width}" height="1" fill="url(#rule)"/>
  `;
}

// ────────────────────────────── glyphs ──────────────────────────────

/**
 * Category glyphs, as SVG paths on a 24×24 grid.
 *
 * A note on where these are and are not used. Apple's `logo` slot is for the *brand* —
 * the airline or cinema chain — displayed beside `logoText`, and a category glyph there
 * is not Apple's convention. Wallet already signals type by other means: the pass
 * style's own top-edge cutout, the transit glyph it draws between origin and
 * destination, and `eventType`.
 *
 * These therefore serve two narrower purposes. `icon.png` is mandatory and is what
 * appears on the lock screen and in notifications, where a category mark is genuinely
 * the right thing. And when no brand logo can be extracted from the ticket, a glyph is
 * a better header than an empty space — but it is only ever a fallback, never something
 * that displaces a real logo we did manage to find.
 *
 * Drawn as solid silhouettes because they render at 29pt, where interior detail turns
 * to mush.
 */
const GLYPHS = {
  // Clapperboard, squared up rather than skewed.
  //
  // The previous version rotated the clapper arm and slanted its stripes with it, which
  // at 29pt turned into a grey smear. Held straight, with the stripes as clean
  // parallelograms sized to stay inside the bar, it survives the size Wallet actually
  // shows it at.
  movie: `<rect x="2" y="9.1" width="20" height="12" rx="1.7"/>
          <rect x="2" y="3.4" width="20" height="4.7" rx="1" opacity="0.85"/>
          <path d="M6.2 3.4h1.7l-1.8 4.7H4.4zM11.2 3.4h1.7l-1.8 4.7H9.4zM16.2 3.4h1.7l-1.8 4.7h-1.7z"
                fill="#000" opacity="0.5"/>
          <rect x="5.2" y="13.4" width="13.6" height="1.5" rx=".75" fill="#000" opacity="0.4"/>
          <rect x="5.2" y="16.6" width="8.4" height="1.5" rx=".75" fill="#000" opacity="0.4"/>`,

  // Aeroplane, viewed from above — the orientation Apple uses for its own transit glyph.
  flight: `<path d="M12 1.6c.95 0 1.7.85 1.7 1.9v4.9l7.9 4.55v2.2l-7.9-2.35v4.35l2.4 1.75v1.75l-4.1-1.15-4.1 1.15V19.3l2.4-1.75v-4.35L2.4 15.55v-2.2l7.9-4.55V3.5c0-1.05.75-1.9 1.7-1.9z"/>`,

  // Train, front elevation — a cab with a tapered roof, sitting on rails.
  //
  // Kept head-on because that is the orientation Apple uses and the one people read as
  // "train". The rails beneath are what carry the meaning: they are the single feature a
  // bus can never have, and they survive at 29pt when window details do not.
  rail: `<path d="M8 2.6h8a3.4 3.4 0 0 1 3.4 3.4v8.6a2.6 2.6 0 0 1-2.6 2.6H7.2a2.6 2.6 0 0 1-2.6-2.6V6A3.4 3.4 0 0 1 8 2.6z"/>
         <path d="M7.4 6.2h9.2a.7.7 0 0 1 .7.7v3.4a.7.7 0 0 1-.7.7H7.4a.7.7 0 0 1-.7-.7V6.9a.7.7 0 0 1 .7-.7z"
               fill="#000" opacity="0.55"/>
         <circle cx="8.4" cy="14" r="1.15" fill="#000" opacity="0.5"/>
         <circle cx="15.6" cy="14" r="1.15" fill="#000" opacity="0.5"/>
         <path d="M9.4 17.2 7 21.4M14.6 17.2 17 21.4" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round"/>
         <path d="M3 19.4h18M3 22h18" fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" opacity="0.8"/>`,

  // Bus, side elevation — deliberately a different view from the train.
  //
  // Front-on, a bus and a train are the same rounded box with two windows, and no amount
  // of detail separates them at icon size. Seen from the side the silhouette is long and
  // low with a wheel at each end and a row of windows — a shape nothing else shares.
  bus: `<path d="M2.6 5.4h14.2a4.6 4.6 0 0 1 3.5 1.6l1.2 1.5a2 2 0 0 1 .5 1.3v5.4a1.4 1.4 0 0 1-1.4 1.4H2.6a1.4 1.4 0 0 1-1.4-1.4V6.8a1.4 1.4 0 0 1 1.4-1.4z"/>
        <rect x="2.9" y="7.6" width="3.4" height="3.6" rx=".6" fill="#000" opacity="0.55"/>
        <rect x="7.3" y="7.6" width="3.4" height="3.6" rx=".6" fill="#000" opacity="0.55"/>
        <rect x="11.7" y="7.6" width="3.4" height="3.6" rx=".6" fill="#000" opacity="0.55"/>
        <path d="M17.2 7.6h1.4a1 1 0 0 1 .8.4l1 1.3a.6.6 0 0 1-.5 1h-2.7a.6.6 0 0 1-.6-.6V8.2a.6.6 0 0 1 .6-.6z"
              fill="#000" opacity="0.55"/>
        <circle cx="6.6" cy="17.6" r="2.4"/>
        <circle cx="17.4" cy="17.6" r="2.4"/>
        <circle cx="6.6" cy="17.6" r="1" fill="#000" opacity="0.5"/>
        <circle cx="17.4" cy="17.6" r="1" fill="#000" opacity="0.5"/>`,

  // Quaver.
  concert: `<path d="M10 4.6 18.4 2a.7.7 0 0 1 .9.7v3a.9.9 0 0 1-.6.8L11 8.9v8.4a3.6 3.6 0 1 1-2-3.2V5.5a.9.9 0 0 1 .7-.9z"/>
            <path d="M19.3 8.1a.7.7 0 0 1 .9.7v2.9a.9.9 0 0 1-.6.9L13 14.5v-3z" opacity="0.7"/>`,

  // A single comedy mask.
  //
  // Two overlapping masks was the right idea and the wrong execution: at 29pt the pair
  // collapsed into one ambiguous blob with four dots in it. One mask, centred and
  // symmetrical, is unmistakably theatrical and survives being shrunk.
  theatre: `<path d="M5.2 3.2h13.6a1.1 1.1 0 0 1 1.1 1.1v6.1a7.9 7.9 0 0 1-15.8 0V4.3a1.1 1.1 0 0 1 1.1-1.1z"/>
            <path d="M7.6 9.1q1.5-1.9 3 0M13.4 9.1q1.5-1.9 3 0" fill="none" stroke="#000"
                  stroke-opacity="0.6" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M8.4 13.4q3.6 3.2 7.2 0" fill="none" stroke="#000" stroke-opacity="0.6"
                  stroke-width="1.6" stroke-linecap="round"/>
            <path d="M4.4 5.2H2.9a1 1 0 0 0 0 2h1.5zM19.6 5.2h1.5a1 1 0 0 1 0 2h-1.5z" opacity="0.7"/>`,

  // Trophy.
  //
  // A football was both fiddly at 29pt — the seams reduced to noise — and wrong for a
  // category that has to cover cricket, kabaddi and everything else. A trophy is
  // sport-neutral, and its silhouette is legible at any size.
  sport: `<path d="M7.4 3h9.2a.8.8 0 0 1 .8.8v4.3a5.4 5.4 0 0 1-10.8 0V3.8a.8.8 0 0 1 .8-.8z"/>
          <path d="M6.7 5.1H5.1a2.8 2.8 0 0 0 2.4 2.8M17.3 5.1h1.6a2.8 2.8 0 0 1-2.4 2.8"
                fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <rect x="11.05" y="13.3" width="1.9" height="3.4"/>
          <path d="M9 20.1c.2-1.9 1.3-3.2 3-3.4 1.7.2 2.8 1.5 3 3.4z"/>
          <rect x="7.2" y="19.9" width="9.6" height="2" rx="1"/>
          <path d="M10.2 5.6h3.6l-1.8 1.4z" fill="#000" opacity="0.4"/>`,

  // Lanyard badge.
  conference: `<path d="M6 6h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/>
               <path d="M9.5 2h5a1 1 0 0 1 1 1v3.4h-7V3a1 1 0 0 1 1-1z" opacity="0.75"/>
               <rect x="7" y="10.5" width="10" height="1.8" rx=".9" fill="#000" opacity="0.5"/>
               <rect x="7" y="14" width="6.5" height="1.8" rx=".9" fill="#000" opacity="0.5"/>`,

  // Takeaway cup — loyalty cards and drink vouchers.
  cafe: `<path d="M5.6 8h12.8l-1.2 11.4a2.4 2.4 0 0 1-2.4 2.2H9.2a2.4 2.4 0 0 1-2.4-2.2z"/>
         <path d="M4.6 5.2h14.8a1 1 0 0 1 1 1.1l-.1 1.1a.8.8 0 0 1-.8.7H4.5a.8.8 0 0 1-.8-.7l-.1-1.1a1 1 0 0 1 1-1.1z" opacity="0.85"/>
         <path d="M8.8 3.4q1.4-1.6 0-3.2M12 3.4q1.4-1.6 0-3.2M15.2 3.4q1.4-1.6 0-3.2" fill="none"
               stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.55"
               transform="translate(0,1.2)"/>
         <rect x="6.2" y="11.4" width="11.6" height="3.4" fill="#000" opacity="0.45"/>`,

  // Torn stub — the universal mark for admission, and the app's own emblem.
  event: `<path d="M3.4 5h17.2a1 1 0 0 1 1 1v3.1a.8.8 0 0 1-.6.8 2.2 2.2 0 0 0 0 4.2.8.8 0 0 1 .6.8V18a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1v-3.1a.8.8 0 0 1 .6-.8 2.2 2.2 0 0 0 0-4.2.8.8 0 0 1-.6-.8V6a1 1 0 0 1 1-1z"/>
          <path d="M14.6 6.6v1.8M14.6 11.1v1.8M14.6 15.6v1.8" stroke="#000" stroke-opacity="0.55" stroke-width="1.3" stroke-linecap="round" fill="none"/>`,
};

/** Boarding passes carry no category art of their own, so flight and rail map here. */
export function glyphFor(category) {
  return GLYPHS[category] || GLYPHS.event;
}

/**
 * The icon. Mandatory — Wallet rejects a pass without one — and the mark that appears
 * on the lock screen, so it must read at 29pt.
 *
 * A filled rounded square rather than a bare glyph, because a transparent icon
 * disappears against the varied backgrounds iOS places it on.
 */
export function buildIconSvg({ category = 'event', palette }) {
  const { width, height } = IMAGE_SLOTS.icon;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="ic" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${palette.background}"/>
      <stop offset="100%" stop-color="${palette.deep}"/>
    </linearGradient></defs>
    <rect width="${width}" height="${height}" rx="${width * 0.22}" fill="url(#ic)"/>
    <g transform="translate(${width * 0.16}, ${height * 0.16}) scale(${(width * 0.68) / 24})"
       fill="${palette.foreground}" color="${palette.foreground}">${glyphFor(category)}</g>
  </svg>`;
}

/**
 * Fallback logo: the glyph beside the provider's name, set the way Apple sets logoText.
 *
 * Only used when no brand mark could be lifted from the ticket. Left-aligned and
 * vertically centred within the 160×50 slot, because Wallet anchors the logo to the
 * top-left of the header and a centred image drifts away from the text beside it.
 */
export function buildLogoSvg({ category = 'event', palette, text = '' } = {}) {
  const { width, height } = IMAGE_SLOTS.logo;
  const glyphSize = height * 0.62;
  const label = String(text).trim().slice(0, 18).toUpperCase()
    .replace(/[<>&]/g, '');

  // Rough advance width for the letter-spaced sans below; overflowing the slot would
  // see Wallet scale the whole logo down, shrinking the glyph with it.
  const fontSize = label.length > 12 ? 11 : 13;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <g transform="translate(0, ${(height - glyphSize) / 2}) scale(${glyphSize / 24})"
       fill="${palette.foreground}" color="${palette.foreground}">${glyphFor(category)}</g>
    ${label ? `<text x="${glyphSize + 9}" y="${height / 2}" dominant-baseline="central"
        font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif"
        font-size="${fontSize}" font-weight="600" letter-spacing="1.1"
        fill="${palette.foreground}">${label}</text>` : ''}
  </svg>`;
}

// ────────────────────────────── assembly ──────────────────────────────

/**
 * Composes the SVG for one slot.
 *
 * The scrim is the important part. Pass text is drawn by Wallet over the middle of the
 * strip, and without a darkening layer beneath it a bright composition can render the
 * seat number unreadable. It costs a little vibrancy and buys legibility, which is not
 * a close call at a cinema door.
 */
export function buildSvg({ slot = 'strip', category = 'event', palette, scrim = true } = {}) {
  const { width, height } = IMAGE_SLOTS[slot] || IMAGE_SLOTS.strip;
  const draw = slot === 'footer' ? footerArt : (COMPOSITIONS[category] || genericStrip);
  const body = draw({ width, height, palette, seed: palette.seed });

  const overlay = scrim && slot !== 'footer'
    ? `<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
         <stop offset="0%" stop-color="#000" stop-opacity="0.30"/>
         <stop offset="55%" stop-color="#000" stop-opacity="0.10"/>
         <stop offset="100%" stop-color="#000" stop-opacity="0.34"/>
       </linearGradient>
       <rect width="${width}" height="${height}" fill="url(#scrim)"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}${overlay}</svg>`;
}

/**
 * Rasterises SVG to PNG bytes at a given scale.
 *
 * Wallet will not accept SVG, so this must become a PNG regardless. Drawing through a
 * canvas keeps it entirely in-process: no encoder library, no upload, and the browser's
 * own renderer does the anti-aliasing better than anything we would ship.
 */
export async function rasterise(svg, scale = 1) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const image = await loadImage(url);
    const width = image.width * scale;
    const height = image.height * scale;

    const canvas = makeCanvas(width, height);

    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);

    if (canvas.convertToBlob) {
      const out = await canvas.convertToBlob({ type: 'image/png' });
      return new Uint8Array(await out.arrayBuffer());
    }

    const dataUrl = canvas.toDataURL('image/png');
    const binary = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The generated artwork could not be rendered.'));
    image.src = url;
  });
}

/**
 * Produces every image file a pass needs, keyed by the filename Wallet expects.
 *
 * `icon` is not optional — a pass without one is rejected outright, and it is what
 * appears in notifications and on the lock screen, so it is generated even when the
 * user has switched decorative artwork off.
 *
 * `brandLogo` should be supplied whenever one was extracted from the ticket. Apple's
 * logo slot is for the provider's own mark, and a real one always beats our glyph; the
 * generated logo exists only so the header is never blank.
 */
export async function generatePassImages({
  category = 'event',
  style = 'eventTicket',
  title = '',
  provider = '',
  seedColor = null,
  includeStrip = true,
  brandLogo = null,
} = {}) {
  const palette = derivePalette({ category, title, seedColor });
  const files = {};

  const add = async (name, svg) => {
    for (const scale of SCALES) {
      files[scale === 1 ? `${name}.png` : `${name}@${scale}x.png`] = await rasterise(svg, scale);
    }
  };

  await add('icon', buildIconSvg({ category, palette }));

  if (brandLogo) {
    // Already-rasterised bytes from the ticket itself, one entry per scale.
    Object.assign(files, brandLogo);
  } else {
    await add('logo', buildLogoSvg({ category, palette, text: provider }));
  }

  // Only some styles carry a strip. A boarding pass gets a 286×15 footer instead —
  // Apple's layout, not a limitation of ours — and a strip supplied to one is simply
  // ignored, so generating it would be wasted bytes.
  if (style === 'boardingPass') {
    await add('footer', buildSvg({ slot: 'footer', category, palette }));
  } else if (includeStrip && STRIP_STYLES.has(style)) {
    await add('strip', buildSvg({ slot: 'strip', category, palette }));
  }

  return { files, palette };
}

/**
 * Wallet's colour keys, in the rgb() form the spec requires.
 *
 * Hex is accepted by recent iOS but silently ignored by older versions, which produces
 * a stark white pass on exactly the devices least likely to be tested against.
 */
export function walletColors(palette) {
  const toRgb = (hex) => {
    const parsed = parseHex(hex) || [0, 0, 0];
    return `rgb(${parsed.join(', ')})`;
  };
  return {
    backgroundColor: toRgb(palette.background),
    foregroundColor: toRgb(palette.foreground),
    labelColor: toRgb(palette.label),
  };
}
