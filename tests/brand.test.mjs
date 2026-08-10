/**
 * Tests for brand extraction.
 *
 * Detection heuristics are the part of this project most likely to be quietly wrong, so
 * they are exercised against synthetic tickets built pixel by pixel: a coloured mark at
 * the top, body text below, and the awkward cases — a logo on a dark panel, a page with
 * no logo at all, a barcode that must not be mistaken for one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateBackground, buildInkMask, findComponents, scoreCandidate, findLogoRegion,
  cropImageData, trimBackground, tightCrop, dominantColour, ensureReadable,
  saturationOf, isNeutral,
} from '../js/brand.js';

/** A blank page in the given colour. */
function page(width, height, [r, g, b] = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { data, width, height };
}

function fill(image, x, y, w, h, [r, g, b], alpha = 255) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      if (col < 0 || row < 0 || col >= image.width || row >= image.height) continue;
      const i = (row * image.width + col) * 4;
      image.data[i] = r; image.data[i + 1] = g; image.data[i + 2] = b; image.data[i + 3] = alpha;
    }
  }
  return image;
}

/** Rows of dark bars, standing in for body text. */
function textBlock(image, x, y, lines, lineWidth = 120) {
  for (let n = 0; n < lines; n++) {
    fill(image, x, y + n * 9, lineWidth - (n % 3) * 18, 4, [32, 32, 32]);
  }
  return image;
}

// ────────────────────────────── colour helpers ──────────────────────────────

test('colour helpers', async (t) => {
  await t.test('measures saturation', () => {
    assert.equal(saturationOf(255, 0, 0), 1);
    assert.equal(saturationOf(128, 128, 128), 0);
    assert.ok(saturationOf(0, 82, 156) > 0.9);
  });

  await t.test('recognises the colours text and paper are made of', () => {
    assert.equal(isNeutral(255, 255, 255), true);
    assert.equal(isNeutral(20, 20, 20), true);
    assert.equal(isNeutral(130, 132, 128), true);
    assert.equal(isNeutral(0, 82, 156), false, 'a brand blue is not neutral');
  });
});

// ────────────────────────────── background ──────────────────────────────

test('background estimation', async (t) => {
  await t.test('finds white paper', () => {
    const image = page(200, 260);
    textBlock(image, 20, 90, 8);
    const background = estimateBackground(image);
    assert.ok(background.every((v) => v >= 240), `expected near-white, got ${background}`);
  });

  await t.test('is not fooled by a large dark mark', () => {
    const image = page(200, 260);
    // A logo covering much of the middle must not become "the background".
    fill(image, 40, 60, 120, 120, [10, 30, 90]);
    const background = estimateBackground(image);
    assert.ok(background.every((v) => v >= 220), `sampling the margins should still see paper, got ${background}`);
  });

  await t.test('handles a dark page', () => {
    const image = page(200, 200, [18, 18, 24]);
    const background = estimateBackground(image);
    assert.ok(background.every((v) => v < 60), `expected a dark background, got ${background}`);
  });
});

// ────────────────────────────── components ──────────────────────────────

test('component detection', async (t) => {
  await t.test('separates a mark from a block of text', () => {
    const image = page(300, 400);
    fill(image, 20, 16, 70, 34, [0, 82, 156]);   // the logo
    textBlock(image, 20, 150, 10);               // body text, well below

    const ink = buildInkMask(image, estimateBackground(image));
    const components = findComponents(ink, { dilate: 3, minPixels: 30 });

    assert.ok(components.length >= 2, 'the mark and the text should not merge');
  });

  await t.test('groups the letters of a wordmark into one region', () => {
    const image = page(300, 200);
    // Six separate letterforms, closely spaced.
    for (let i = 0; i < 6; i++) fill(image, 20 + i * 14, 20, 9, 22, [200, 40, 60]);

    const ink = buildInkMask(image, estimateBackground(image));
    const components = findComponents(ink, { dilate: 5, minPixels: 20 });

    const wide = components.filter((c) => c.width > 60);
    assert.equal(wide.length, 1, 'dilation should join the letters into a single wordmark');
  });

  await t.test('reports how colourful a region is', () => {
    const image = page(200, 200);
    fill(image, 20, 20, 60, 30, [220, 30, 40]);

    const ink = buildInkMask(image, estimateBackground(image));
    const [component] = findComponents(ink, { dilate: 2, minPixels: 20 });

    assert.ok(component.colourfulness > 0.8, 'a solid red block is unambiguously colourful');
  });

  await t.test('marks black text as not colourful', () => {
    const image = page(200, 200);
    fill(image, 20, 20, 60, 30, [26, 26, 26]);

    const ink = buildInkMask(image, estimateBackground(image));
    const [component] = findComponents(ink, { dilate: 2, minPixels: 20 });

    assert.ok(component.colourfulness < 0.15, 'black ink must not read as a brand colour');
  });
});

// ────────────────────────────── scoring ──────────────────────────────

test('candidate scoring', async (t) => {
  const bounds = { width: 400, height: 130 };

  await t.test('prefers a coloured mark over black text of the same shape', () => {
    const shape = { x: 20, y: 10, width: 90, height: 40, inkPixels: 2200 };
    const coloured = scoreCandidate({ ...shape, colourfulness: 0.95, meanSaturation: 0.8 }, bounds);
    const black = scoreCandidate({ ...shape, colourfulness: 0.02, meanSaturation: 0.02 }, bounds);

    assert.ok(coloured > black, 'colour is the strongest signal we have');
  });

  await t.test('rejects a long thin rule', () => {
    const score = scoreCandidate(
      { x: 0, y: 20, width: 380, height: 3, inkPixels: 1000, colourfulness: 0.9, meanSaturation: 0.7 },
      bounds,
    );
    assert.equal(score, 0, 'a horizontal rule is not a logo');
  });

  await t.test('rejects a region covering most of the band', () => {
    const score = scoreCandidate(
      { x: 0, y: 0, width: 390, height: 125, inkPixels: 40000, colourfulness: 0.9, meanSaturation: 0.7 },
      bounds,
    );
    assert.equal(score, 0, 'that is a background panel, not a mark');
  });

  await t.test('rejects a sparse outline', () => {
    const score = scoreCandidate(
      { x: 20, y: 10, width: 100, height: 60, inkPixels: 150, colourfulness: 0.9, meanSaturation: 0.7 },
      bounds,
    );
    assert.equal(score, 0, 'mostly empty means a border, not a logo');
  });

  await t.test('rejects a striped region however well placed', () => {
    // A barcode scores respectably on position, shape and density. Only its stripe
    // frequency gives it away.
    const score = scoreCandidate(
      { x: 20, y: 8, width: 200, height: 60, inkPixels: 6000, colourfulness: 0, meanSaturation: 0, transitionRate: 0.25 },
      bounds,
    );
    assert.equal(score, 0, 'a barcode must never reach the logo slot');
  });

  await t.test('accepts a solid mark with few transitions', () => {
    const score = scoreCandidate(
      { x: 20, y: 8, width: 90, height: 40, inkPixels: 2600, colourfulness: 0.9, meanSaturation: 0.7, transitionRate: 0.02 },
      bounds,
    );
    assert.ok(score > 50, `a clean coloured mark should score well, got ${score}`);
  });

  await t.test('prefers a mark at the very top', () => {
    const shape = { width: 90, height: 40, inkPixels: 2200, colourfulness: 0.9, meanSaturation: 0.7 };
    const high = scoreCandidate({ ...shape, x: 20, y: 4 }, bounds);
    const low = scoreCandidate({ ...shape, x: 20, y: 60 }, bounds);
    assert.ok(high > low);
  });
});

// ────────────────────────────── end-to-end detection ──────────────────────────────

test('finding a logo', async (t) => {
  await t.test('finds a coloured mark at the top of a ticket', () => {
    const image = page(400, 560);
    fill(image, 24, 18, 96, 40, [0, 82, 156]);
    textBlock(image, 24, 220, 14, 300);

    const region = findLogoRegion(image);
    assert.ok(region, 'a clear brand mark should be found');
    assert.ok(region.x <= 30 && region.y <= 26, `expected the top-left mark, got ${JSON.stringify(region)}`);
    assert.ok(region.width >= 90 && region.width <= 130);
  });

  await t.test('returns nothing rather than guessing on a plain page', () => {
    const image = page(400, 560);
    textBlock(image, 24, 30, 26, 320);

    const region = findLogoRegion(image);
    assert.equal(region, null, 'black text alone must not be promoted to a logo');
  });

  await t.test('ignores a barcode', () => {
    const image = page(400, 560);
    // Alternating black bars: high ink, no colour.
    for (let x = 40; x < 300; x += 4) fill(image, x, 20, 2, 60, [0, 0, 0]);

    const region = findLogoRegion(image);
    assert.equal(region, null, 'a barcode is not a brand mark');
  });

  await t.test('does not look below the top of the page', () => {
    const image = page(400, 560);
    // A coloured block far down the page — a photo or a footer, not a logo.
    fill(image, 24, 430, 96, 40, [0, 82, 156]);

    const region = findLogoRegion(image);
    assert.equal(region, null, 'the search band must stay near the top');
  });
});

// ────────────────────────────── trimming ──────────────────────────────

test('trimming', async (t) => {
  await t.test('makes a uniform surround transparent', () => {
    // A red mark on a dark panel — the IndiGo-in-a-box case.
    const image = page(60, 40, [16, 20, 44]);
    fill(image, 18, 12, 24, 16, [230, 60, 70]);

    const trimmed = trimBackground(image);

    // The panel is gone and the mark survives.
    assert.ok(trimmed.width <= 30, `expected a tight crop, got ${trimmed.width}px wide`);
    const centre = ((trimmed.height >> 1) * trimmed.width + (trimmed.width >> 1)) * 4;
    assert.equal(trimmed.data[centre + 3], 255, 'the mark itself must stay opaque');
  });

  await t.test('does not punch through an enclosed counter', () => {
    // A ring: the hole in the middle matches the surround but is not connected to it.
    const image = page(40, 40, [255, 255, 255]);
    fill(image, 8, 8, 24, 24, [20, 60, 200]);
    fill(image, 16, 16, 8, 8, [255, 255, 255]);

    const trimmed = trimBackground(image);
    const middle = ((trimmed.height >> 1) * trimmed.width + (trimmed.width >> 1)) * 4;

    assert.equal(trimmed.data[middle + 3], 255, 'the hole in an O must not become transparent');
  });

  await t.test('crops away transparent margins', () => {
    const image = page(50, 50, [255, 255, 255]);
    for (let i = 0; i < image.data.length; i += 4) image.data[i + 3] = 0;
    fill(image, 20, 20, 10, 10, [0, 0, 0], 255);

    const cropped = tightCrop(image);
    assert.equal(cropped.width, 10);
    assert.equal(cropped.height, 10);
  });

  await t.test('leaves an image with no transparency alone', () => {
    const image = page(20, 20, [10, 10, 10]);
    const cropped = tightCrop(image);
    assert.equal(cropped.width, 20);
  });
});

// ────────────────────────────── dominant colour ──────────────────────────────

test('dominant colour', async (t) => {
  await t.test('finds the brand colour, not the paper', () => {
    const image = page(80, 80, [255, 255, 255]);
    fill(image, 10, 10, 40, 40, [0, 82, 156]);

    const colour = dominantColour(image);
    assert.ok(colour, 'a solid coloured mark has a dominant colour');
    assert.ok(Math.abs(colour.rgb[2] - 156) < 20, `expected the blue, got ${colour.hex}`);
  });

  await t.test('ignores black text sitting beside the mark', () => {
    const image = page(120, 80, [255, 255, 255]);
    fill(image, 4, 4, 60, 70, [20, 20, 20]);   // a lot of black
    fill(image, 70, 20, 30, 30, [220, 40, 50]); // less red

    const colour = dominantColour(image);
    assert.ok(colour.rgb[0] > 150, `expected the red brand colour, got ${colour.hex}`);
  });

  await t.test('returns nothing for a greyscale mark', () => {
    const image = page(60, 60, [255, 255, 255]);
    fill(image, 10, 10, 30, 30, [90, 90, 92]);

    assert.equal(dominantColour(image), null, 'grey is not a brand colour worth using');
  });
});

// ────────────────────────────── contrast guard ──────────────────────────────

test('readability guard', async (t) => {
  await t.test('leaves a dark brand colour alone', () => {
    const result = ensureReadable('#003d7a');
    assert.equal(result.adjusted, false, 'a deep blue already carries white text');
    assert.equal(result.background, '#003d7a');
    assert.ok(result.ratio >= 4.5);
  });

  await t.test('flips the text colour rather than spoiling a bright brand colour', () => {
    // A bright airline yellow. White text over it is unreadable, but black text is
    // perfectly legible — so the brand colour survives untouched, which is what Apple
    // does with its own yellow passes.
    const result = ensureReadable('#ffd400');
    assert.equal(result.passes, true);
    assert.equal(result.background, '#ffd400', 'the brand colour must be preserved');
    assert.equal(result.foreground, '#111111', 'legibility comes from the text colour here');
    assert.ok(result.ratio >= 4.5, `contrast was only ${result.ratio}`);
  });

  await t.test('darkens only when neither white nor black text would do', () => {
    // A mid-tone blue: white text reaches 4.48 and black 4.21, so both fall short and
    // the background itself has to move. Roughly 3% of the colour space lands here.
    const result = ensureReadable('#0077dd');
    assert.equal(result.adjusted, true, 'the user must be told, not silently overridden');
    assert.equal(result.original, '#0077dd');
    assert.notEqual(result.background, '#0077dd');
    assert.ok(result.ratio >= 4.5, `contrast was only ${result.ratio}`);
  });

  await t.test('reports honestly when it left the colour alone', () => {
    const result = ensureReadable('#003d7a');
    assert.equal(result.adjusted, false);
    assert.equal(result.background, result.original);
  });

  await t.test('keeps the hue while adjusting the shade', () => {
    const result = ensureReadable('#ff8800');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(result.background.slice(i, i + 2), 16));
    assert.ok(r > g && g > b, `an orange must stay orange, got ${result.background}`);
  });

  await t.test('refuses invalid input rather than inventing a colour', () => {
    assert.equal(ensureReadable('not a colour'), null);
    assert.equal(ensureReadable(''), null);
  });

  await t.test('never returns a failing combination', () => {
    for (const hex of ['#ffffff', '#ffff00', '#00ff00', '#ff00ff', '#000000', '#7f7f7f']) {
      const result = ensureReadable(hex);
      assert.ok(result.ratio >= 4.5, `${hex} produced only ${result.ratio}:1`);
    }
  });
});

// ────────────────────────────── cropping ──────────────────────────────

test('cropping', async (t) => {
  await t.test('extracts the requested rectangle', () => {
    const image = page(40, 40, [255, 255, 255]);
    fill(image, 10, 10, 10, 10, [255, 0, 0]);

    const cropped = cropImageData(image, { x: 10, y: 10, width: 10, height: 10 });
    assert.equal(cropped.width, 10);
    assert.equal(cropped.data[0], 255);
    assert.equal(cropped.data[1], 0);
  });
});
