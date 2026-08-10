/**
 * Brand extraction — lifts the operator's own logo and colour off the ticket.
 *
 * A pass that carries the airline's actual mark and its actual blue feels issued. One
 * carrying our generated glyph and a guessed colour feels like a photocopy. That
 * difference is most of what makes someone trust the thing at a barrier, so it is worth
 * real effort.
 *
 * No new dependencies: the ticket has already been rendered to a canvas for barcode
 * decoding, so the pixels are sitting there. The work is a background-colour estimate,
 * a connected-component pass over the top of the page, and a small colour histogram —
 * a few hundred lines against pixels we have already paid for.
 *
 * The pixel logic is deliberately pure, operating on plain {data, width, height}
 * objects rather than canvases. Detection heuristics are the part most likely to be
 * wrong, and untestable heuristics stay wrong.
 *
 * Nothing here is ever load-bearing. Every function degrades to null, and the caller
 * falls back to a generated logo and a category colour. Extraction is a convenience,
 * never a dependency.
 */

import { parseHex, luminance, contrastRatio } from './artwork.js';

/** Logos sit at the top of a ticket. Below this we are looking at the body text. */
const SEARCH_BAND = 0.32;

/** Working width for detection. Full resolution buys nothing and costs time. */
const WORK_WIDTH = 460;

// ────────────────────────────── colour helpers ──────────────────────────────

/** Saturation and value, in the HSV sense. Saturation is how we tell ink from brand. */
export function saturationOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/** True for greys, blacks and whites — the colours body text and paper are made of. */
export function isNeutral(r, g, b, { threshold = 0.22 } = {}) {
  return saturationOf(r, g, b) < threshold;
}

function colourDistance(a, b) {
  // Weighted toward green, roughly matching human sensitivity. Good enough to decide
  // whether two pixels are "the same colour" without the cost of a Lab conversion.
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db);
}

// ────────────────────────────── image primitives ──────────────────────────────

/**
 * Estimates the page background.
 *
 * Sampled from the edges rather than the whole image: the middle of a ticket is mostly
 * content, while the margins are almost always paper. A background estimate skewed by
 * a large dark logo would classify the entire page as ink.
 */
export function estimateBackground({ data, width, height }) {
  const counts = new Map();

  const sample = (x, y) => {
    const i = (y * width + x) * 4;
    if (data[i + 3] < 128) return;
    // Quantised to 16 levels per channel so near-identical whites group together.
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  };

  const margin = Math.max(2, Math.floor(Math.min(width, height) * 0.04));
  for (let x = 0; x < width; x += 2) {
    for (let y = 0; y < margin; y++) { sample(x, y); sample(x, height - 1 - y); }
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < margin; x++) { sample(x, y); sample(width - 1 - x, y); }
  }

  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) { bestCount = count; best = key; }
  }
  if (best === null) return [255, 255, 255];

  return [((best >> 8) & 0xf) * 17, ((best >> 4) & 0xf) * 17, (best & 0xf) * 17];
}

/**
 * Marks pixels that differ from the background — the ink of the page.
 *
 * Returns a Uint8Array mask plus a parallel saturation map, since the component scorer
 * needs to know not merely where the ink is but whether it is coloured.
 */
export function buildInkMask({ data, width, height }, background, { threshold = 60 } = {}) {
  const mask = new Uint8Array(width * height);
  const saturation = new Float32Array(width * height);

  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    if (data[i + 3] < 100) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (colourDistance([r, g, b], background) > threshold) {
      mask[p] = 1;
      saturation[p] = saturationOf(r, g, b);
    }
  }

  return { mask, saturation, width, height };
}

/**
 * Groups ink into connected components.
 *
 * Dilated first, because a wordmark is a row of separate letters and we want the whole
 * word as one region rather than eight unrelated fragments. The dilation radius scales
 * with image width so behaviour does not change with resolution.
 */
export function findComponents({ mask, saturation, width, height }, { dilate = 3, minPixels = 40 } = {}) {
  const dilated = dilateMask(mask, width, height, dilate);
  const labels = new Int32Array(width * height).fill(-1);
  const components = [];

  const queue = new Int32Array(width * height);

  for (let start = 0; start < dilated.length; start++) {
    if (!dilated[start] || labels[start] !== -1) continue;

    const id = components.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = id;

    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let inkPixels = 0;
    let saturatedPixels = 0;
    let saturationSum = 0;

    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = (p / width) | 0;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (mask[p]) {
        inkPixels++;
        saturationSum += saturation[p];
        if (saturation[p] >= 0.22) saturatedPixels++;
      }

      // Four-connectivity is sufficient once the mask has been dilated.
      if (x > 0 && dilated[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; queue[tail++] = p - 1; }
      if (x < width - 1 && dilated[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; queue[tail++] = p + 1; }
      if (y > 0 && dilated[p - width] && labels[p - width] === -1) { labels[p - width] = id; queue[tail++] = p - width; }
      if (y < height - 1 && dilated[p + width] && labels[p + width] === -1) { labels[p + width] = id; queue[tail++] = p + width; }
    }

    if (inkPixels < minPixels) continue;

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;

    components.push({
      x: minX,
      y: minY,
      width: boxWidth,
      height: boxHeight,
      inkPixels,
      colourfulness: inkPixels ? saturatedPixels / inkPixels : 0,
      meanSaturation: inkPixels ? saturationSum / inkPixels : 0,
      transitionRate: measureTransitionRate(mask, width, minX, minY, boxWidth, boxHeight),
    });
  }

  return components;
}

/**
 * Counts how often a horizontal scanline crosses between ink and background.
 *
 * This is what separates a barcode from a logo, and nothing else in the scorer does.
 * A barcode is stripes by definition — dozens of crossings per row — where a mark, even
 * an intricate one, has a handful. Without this a wide black barcode scores respectably
 * on position, shape and density, and lands in the logo slot: a pass whose header is a
 * picture of a barcode.
 *
 * Measured on the undilated mask, since dilation is what fuses the stripes into a solid
 * block and destroys the very signal we need.
 */
function measureTransitionRate(mask, stride, x, y, width, height) {
  if (width < 4) return 0;

  let transitions = 0;
  let rows = 0;

  // A sample of rows is enough, and keeps this cheap on tall regions.
  const step = Math.max(1, Math.floor(height / 12));
  for (let row = y; row < y + height; row += step) {
    let previous = 0;
    let rowTransitions = 0;
    for (let col = x; col < x + width; col++) {
      const value = mask[row * stride + col];
      if (value !== previous) rowTransitions++;
      previous = value;
    }
    transitions += rowTransitions;
    rows++;
  }

  return rows ? transitions / rows / width : 0;
}

function dilateMask(mask, width, height, radius) {
  if (radius <= 0) return mask;

  // Separable: a horizontal pass then a vertical one, which is O(n) rather than O(n·r²).
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let run = 0;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) run = radius + 1;
      if (run > 0) { horizontal[row + x] = 1; run--; }
    }
    run = 0;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[row + x]) run = radius + 1;
      if (run > 0) { horizontal[row + x] = 1; run--; }
    }
  }

  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y < height; y++) {
      if (horizontal[y * width + x]) run = radius + 1;
      if (run > 0) { out[y * width + x] = 1; run--; }
    }
    run = 0;
    for (let y = height - 1; y >= 0; y--) {
      if (horizontal[y * width + x]) run = radius + 1;
      if (run > 0) { out[y * width + x] = 1; run--; }
    }
  }

  return out;
}

/**
 * Scores a candidate region for how much it looks like a logo rather than a paragraph.
 *
 * The signals, in rough order of usefulness:
 *   - colour, because body text is black and brands rarely are;
 *   - position, because logos sit at the top and usually left or centre;
 *   - shape, because a logo is compact where a line of text is long and thin;
 *   - density, because a wide sparse region is a rule or a table border.
 *
 * Deliberately conservative: a wrong logo — a stray photograph, a barcode — is more
 * embarrassing than no logo, and the fallback is perfectly presentable.
 */
export function scoreCandidate(component, { width, height }) {
  const aspect = component.width / Math.max(component.height, 1);
  const area = component.width * component.height;
  const coverage = area / (width * height);
  const density = component.inkPixels / Math.max(area, 1);

  // Rule out the obviously wrong before scoring the plausible.
  if (coverage > 0.42) return 0;           // a background panel, not a mark
  if (coverage < 0.0012) return 0;         // noise or a speck of dust
  if (aspect > 9 || aspect < 0.14) return 0; // a rule, a border or a barcode edge
  if (density < 0.06) return 0;            // an outline of something, mostly empty

  // Stripes. A barcode crosses between ink and paper dozens of times per row, where
  // even a detailed logo manages a few. This is the only thing standing between us and
  // a pass whose header is a picture of a barcode.
  if ((component.transitionRate ?? 0) > 0.08) return 0;

  let score = 0;

  // Colour is the strongest single signal.
  score += component.colourfulness * 46;
  score += Math.min(component.meanSaturation * 30, 22);

  // Height in the page: the very top is where a mark belongs.
  const verticalPosition = component.y / Math.max(height, 1);
  if (verticalPosition < 0.10) score += 22;
  else if (verticalPosition < 0.20) score += 14;
  else if (verticalPosition < 0.32) score += 6;

  // Horizontal position: left or centred, rarely hard right.
  const centre = (component.x + component.width / 2) / Math.max(width, 1);
  if (centre < 0.42) score += 10;
  else if (centre < 0.62) score += 7;

  // Shape: wordmarks are wide-ish, roundels are square. Both are fine; a sliver is not.
  if (aspect >= 0.5 && aspect <= 5.5) score += 12;

  // Size: big enough to be deliberate, small enough not to be the whole header.
  if (coverage > 0.004 && coverage < 0.16) score += 12;

  score += Math.min(density * 14, 10);

  return score;
}

/**
 * Picks the most logo-like region in the top band of the page.
 *
 * Returns null rather than a poor guess when nothing scores well, because the caller's
 * fallback is good and a wrong mark is worse than a generated one.
 */
export function findLogoRegion(imageData, { searchBand = SEARCH_BAND, minScore = 42 } = {}) {
  const { width, height } = imageData;
  const bandHeight = Math.max(1, Math.floor(height * searchBand));

  const band = cropImageData(imageData, { x: 0, y: 0, width, height: bandHeight });
  const background = estimateBackground(imageData);
  const ink = buildInkMask(band, background);

  const dilate = Math.max(2, Math.round(width / 150));
  const components = findComponents(ink, { dilate, minPixels: Math.max(30, (width * height) / 60000) });

  const scored = components
    .map((component) => ({ component, score: scoreCandidate(component, { width, height: bandHeight }) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  const best = scored[0].component;

  // A little breathing room, since the dilation may have clipped a thin stroke.
  const padding = Math.round(Math.max(best.width, best.height) * 0.06) + 2;

  return {
    x: Math.max(0, best.x - padding),
    y: Math.max(0, best.y - padding),
    width: Math.min(width - Math.max(0, best.x - padding), best.width + padding * 2),
    height: Math.min(bandHeight - Math.max(0, best.y - padding), best.height + padding * 2),
    score: Math.round(scored[0].score),
    colourfulness: Number(best.colourfulness.toFixed(3)),
    background,
  };
}

// ────────────────────────────── cropping and trimming ──────────────────────────────

export function cropImageData({ data, width }, { x, y, width: w, height: h }) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * width + x) * 4;
    out.set(data.subarray(from, from + w * 4), row * w * 4);
  }
  return { data: out, width: w, height: h };
}

/**
 * Makes a uniform background transparent.
 *
 * This exists because of a specific, visible flaw: lifting a logo printed on a dark
 * panel yields a mark sitting in a rectangle of that panel's colour, which then floats
 * on the pass looking like a mistake. Flood-filling inward from the edges removes the
 * surround while leaving any enclosed counters — the hole in an O — untouched, which a
 * global colour-match would wrongly punch through.
 */
export function trimBackground(imageData, { tolerance = 46 } = {}) {
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data);

  // The surround is whatever colour dominates the border.
  const surround = estimateBackground(imageData);

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const consider = (p) => {
    if (visited[p]) return;
    const i = p * 4;
    if (colourDistance([out[i], out[i + 1], out[i + 2]], surround) > tolerance) return;
    visited[p] = 1;
    queue[tail++] = p;
  };

  for (let x = 0; x < width; x++) { consider(x); consider((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { consider(y * width); consider(y * width + width - 1); }

  while (head < tail) {
    const p = queue[head++];
    out[p * 4 + 3] = 0;

    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) consider(p - 1);
    if (x < width - 1) consider(p + 1);
    if (y > 0) consider(p - width);
    if (y < height - 1) consider(p + width);
  }

  // Tighten to what actually remains, so the logo fills its slot rather than floating
  // inside a mostly-empty rectangle.
  return tightCrop({ data: out, width, height });
}

/** Crops away fully transparent margins. */
export function tightCrop(imageData) {
  const { data, width, height } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return imageData;

  return cropImageData(imageData, {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  });
}

// ────────────────────────────── dominant colour ──────────────────────────────

/**
 * Finds the colour a person would name if asked what colour the logo is.
 *
 * Neutrals are excluded first, because almost every logo sits on white and contains
 * black text; counting those would return grey for everything. Remaining pixels are
 * bucketed coarsely and the winning bucket is averaged at full precision, which avoids
 * the banding that returning the bucket centre would cause.
 */
export function dominantColour(imageData, { minSaturation = 0.25, minPixels = 12 } = {}) {
  const { data } = imageData;
  const buckets = new Map();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (saturationOf(r, g, b) < minSaturation) continue;

    // Very dark and very light pixels carry unreliable hue.
    const l = luminance([r, g, b]);
    if (l < 0.02 || l > 0.92) continue;

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { count: 0, r: 0, g: 0, b: 0 }; buckets.set(key, bucket); }
    bucket.count++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
  }

  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }

  if (!best || best.count < minPixels) return null;

  const rgb = [
    Math.round(best.r / best.count),
    Math.round(best.g / best.count),
    Math.round(best.b / best.count),
  ];

  return {
    rgb,
    hex: `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`,
    pixels: best.count,
  };
}

/**
 * Guarantees the pass stays readable.
 *
 * A brand colour is a suggestion; legibility is not negotiable. Many brand colours are
 * bright — airline yellows, cinema oranges — and white text over them is unreadable.
 * The hue is preserved and the lightness moved until the contrast target is met, so the
 * pass still looks like the brand while the seat number stays legible.
 *
 * Returns the adjustment made, so the UI can tell the user rather than quietly
 * overriding their choice.
 */
export function ensureReadable(hex, { target = 4.5, prefer = 'white' } = {}) {
  const rgb = parseHex(hex);
  if (!rgb) return null;

  const white = [255, 255, 255];
  const black = [17, 17, 17];

  const pick = (colour) => {
    const onWhite = contrastRatio(colour, white);
    const onBlack = contrastRatio(colour, black);
    if (prefer === 'white' && onWhite >= target) return { foreground: white, ratio: onWhite };
    if (onWhite >= onBlack) return { foreground: white, ratio: onWhite };
    return { foreground: black, ratio: onBlack };
  };

  let current = rgb;
  let chosen = pick(current);
  let adjusted = false;

  // Darken toward the brand hue until white text is comfortably legible. Darkening is
  // preferred over lightening because pass backgrounds read better dark, and because
  // Apple's own passes are overwhelmingly dark.
  let guard = 0;
  while (chosen.ratio < target && guard++ < 24) {
    current = current.map((v) => Math.max(0, Math.round(v * 0.9)));
    chosen = pick(current);
    adjusted = true;
    if (current.every((v) => v <= 8)) break;
  }

  const toHex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;

  return {
    background: toHex(current),
    foreground: toHex(chosen.foreground),
    ratio: Number(chosen.ratio.toFixed(2)),
    adjusted,
    original: hex,
    passes: chosen.ratio >= target,
  };
}

// ────────────────────────────── browser orchestration ──────────────────────────────

/**
 * Extracts a logo and colour from an already-rendered ticket canvas.
 *
 * Browser only, since it needs a canvas. Returns null on any failure rather than
 * throwing: the pass must still build when extraction finds nothing.
 */
export async function extractBrand(canvas, { searchBand = SEARCH_BAND, minScore = 42 } = {}) {
  if (!canvas?.width) return null;

  try {
    const scale = Math.min(1, WORK_WIDTH / canvas.width);
    const work = downscale(canvas, scale);
    const context = work.getContext('2d', { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, work.width, work.height);

    const region = findLogoRegion(imageData, { searchBand, minScore });
    if (!region) return null;

    // Re-crop from the full-resolution original: detection is cheap at low resolution,
    // but the mark itself must be lifted at the best quality available.
    const factor = canvas.width / work.width;
    const full = canvas.getContext('2d', { willReadFrequently: true }).getImageData(
      Math.round(region.x * factor),
      Math.round(region.y * factor),
      Math.max(1, Math.round(region.width * factor)),
      Math.max(1, Math.round(region.height * factor)),
    );

    const trimmed = trimBackground({ data: full.data, width: full.width, height: full.height });
    const colour = dominantColour(trimmed) || dominantColour({ data: full.data, width: full.width, height: full.height });

    return {
      image: trimmed,
      seedColor: colour?.hex || null,
      readable: colour ? ensureReadable(colour.hex) : null,
      region,
      confidence: region.score >= 70 ? 'high' : region.score >= 52 ? 'medium' : 'low',
    };
  } catch {
    // Tainted canvas, zero-size crop, or anything else — the fallback covers it.
    return null;
  }
}

function downscale(canvas, scale) {
  if (scale >= 1) return canvas;

  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const out = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });

  const context = out.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(canvas, 0, 0, width, height);
  return out;
}

/**
 * Renders an extracted mark into Apple's 160×50 logo slot at each scale.
 *
 * Contained rather than stretched, and left-aligned because Wallet anchors the logo to
 * the top-left of the header — a centred image drifts away from the text beside it.
 */
export async function renderBrandLogo(image, { slot = { width: 160, height: 50 } } = {}) {
  if (!image?.width || !image?.height) return null;

  const files = {};

  for (const scale of [1, 2, 3]) {
    const width = slot.width * scale;
    const height = slot.height * scale;

    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';

    const source = toCanvas(image);
    const factor = Math.min(width / image.width, height / image.height);
    const drawWidth = Math.round(image.width * factor);
    const drawHeight = Math.round(image.height * factor);

    context.drawImage(source, 0, Math.round((height - drawHeight) / 2), drawWidth, drawHeight);

    const blob = await (canvas.convertToBlob
      ? canvas.convertToBlob({ type: 'image/png' })
      : new Promise((resolve) => canvas.toBlob(resolve, 'image/png')));

    files[scale === 1 ? 'logo.png' : `logo@${scale}x.png`] = new Uint8Array(await blob.arrayBuffer());
  }

  return files;
}

function toCanvas({ data, width, height }) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d');
  context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvas;
}
