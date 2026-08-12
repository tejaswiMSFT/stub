/**
 * Traces the mark's outline and compares it against a reference image.
 *
 * This exists because eyeballing a drawn shape against a picture failed three times in a
 * row. Each attempt produced something that looked roughly right and was wrong in a way
 * no amount of staring surfaced: too shallow a notch, too tight a corner, the wrong
 * aspect. Measuring settled it in one pass.
 *
 * For every row of the shape it records where the ink starts and stops, normalised to the
 * shape's own width, so two drawings at different pixel sizes compare directly. The
 * profile encodes corner radius, notch depth and notch span at once — the three things
 * that were each wrong in turn.
 *
 * Read the middle of the profile for the notch and the ends for the corner. Confusing the
 * two is itself a mistake this tool caused once: the corner inset at t=1.00 was taken for
 * the notch depth, and cutting to it produced a waist far deeper than intended.
 *
 * Usage: node tools/probe-trace-mark.mjs [path-to-reference.png]
 * With no argument it prints the shipped mark's profile alone, which is enough to check a
 * change did what was intended.
 */

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { markSvg } from '../js/brand-identity.js';

const reference = process.argv[2] || null;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });

/**
 * Reads the boundary of the shape in an image.
 *
 * `inkTest` arrives as source rather than a function because it has to be compiled inside
 * the page; a closure cannot cross that boundary.
 */
async function trace(dataUrl, region, inkTest) {
  return page.evaluate(async ({ url, box, test }) => {
    const img = new Image();
    img.src = url;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const area = box || { x: 0, y: 0, w: img.width, h: img.height };
    const { data } = ctx.getImageData(area.x, area.y, area.w, area.h);
    // eslint-disable-next-line no-new-func
    const isInk = new Function(`return ${test}`)();

    const at = (x, y) => {
      const i = (y * area.w + x) * 4;
      return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
    };

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let y = 0; y < area.h; y += 1) {
      for (let x = 0; x < area.w; x += 1) {
        if (isInk(at(x, y))) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (minX === Infinity) return null;

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;

    // 41 samples: enough to resolve a corner and a notch without a wall of numbers.
    const samples = [];
    for (let i = 0; i <= 40; i += 1) {
      const t = i / 40;
      const y = Math.min(maxY, minY + Math.round(t * (h - 1)));
      let left = null; let right = null;
      for (let x = minX; x <= maxX; x += 1) {
        if (isInk(at(x, y))) { if (left === null) left = x; right = x; }
      }
      samples.push({
        t: +t.toFixed(3),
        left: left === null ? null : +((left - minX) / w).toFixed(4),
        right: right === null ? null : +((right - minX) / w).toFixed(4),
      });
    }

    return { width: w, height: h, ratio: +(w / h).toFixed(3), samples };
  }, { url: dataUrl, box: region, test: inkTest });
}

// Rendered flat, so the trace measures geometry rather than a gradient's edges.
const mineSvg = markSvg({ size: 400, variant: 'plain', colour: '#5B4FE8' });
const mine = await trace(
  `data:image/svg+xml;base64,${Buffer.from(mineSvg).toString('base64')}`,
  null,
  '(p) => p.a > 128',
);

let ref = null;
if (reference) {
  const bytes = await readFile(reference);
  ref = await trace(
    `data:image/png;base64,${bytes.toString('base64')}`,
    null,
    // Saturated blue-violet against a light ground.
    '(p) => p.b > 120 && p.b - p.g > 45 && p.r < p.b - 20',
  );
}

await browser.close();

/** Depth of the side notch: the furthest the left edge travels inward at mid-height. */
const notchDepth = (profile) => Math.max(
  ...profile.samples.filter((s) => s.t > 0.3 && s.t < 0.7 && s.left !== null).map((s) => s.left),
);

/** Corner inset: how far in the very first row starts. */
const cornerInset = (profile) => profile.samples[0].left;

console.log(`shipped    ${mine.width}x${mine.height}  ratio ${mine.ratio}`);
if (ref) console.log(`reference  ${ref.width}x${ref.height}  ratio ${ref.ratio}`);
console.log('');

if (ref) {
  console.log('  t      ref-left  mine-left     ref-right  mine-right');
  for (let i = 0; i < mine.samples.length; i += 2) {
    const m = mine.samples[i];
    const r = ref.samples[i];
    const fmt = (v) => (v === null ? '  --  ' : v.toFixed(3));
    const delta = r.left !== null && m.left !== null ? Math.abs(r.left - m.left) : 0;
    console.log(`  ${m.t.toFixed(2)}   ${fmt(r.left)}     ${fmt(m.left)}         ${fmt(r.right)}     ${fmt(m.right)}${delta > 0.03 ? '  <<' : ''}`);
  }
} else {
  console.log('  t      left    right');
  for (let i = 0; i < mine.samples.length; i += 2) {
    const m = mine.samples[i];
    const fmt = (v) => (v === null ? '  --  ' : v.toFixed(3));
    console.log(`  ${m.t.toFixed(2)}   ${fmt(m.left)}   ${fmt(m.right)}`);
  }
}

console.log('');
console.log(`notch depth (mid)   shipped ${notchDepth(mine).toFixed(3)}${ref ? `   reference ${notchDepth(ref).toFixed(3)}` : ''}`);
console.log(`corner inset (top)  shipped ${cornerInset(mine).toFixed(3)}${ref ? `   reference ${cornerInset(ref).toFixed(3)}` : ''}`);
