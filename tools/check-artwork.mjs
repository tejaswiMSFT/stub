/**
 * Artwork sanity check.
 *
 * Verifies that every category renders, that no palette falls below the WCAG AA
 * threshold, and — the failure that actually bit us twice — that categories which sit
 * beside each other are far enough apart in hue to be told apart at a glance.
 */

import { derivePalette, buildIconSvg, buildSvg, buildLogoSvg } from '../js/artwork.js';

const CATS = ['movie', 'theatre', 'concert', 'sport', 'conference', 'cafe', 'event', 'flight', 'rail', 'bus'];

console.log('category    background  contrast   icon   art');
console.log('-'.repeat(52));

let worst = 99;
for (const c of CATS) {
  const p = derivePalette({ category: c, title: 'Sample' });
  const icon = buildIconSvg({ category: c, palette: p });
  const boarding = ['flight', 'rail', 'bus'].includes(c);
  const art = buildSvg({ slot: boarding ? 'footer' : 'strip', category: c, palette: p });
  buildLogoSvg({ category: c, palette: p, text: 'BRAND' });

  worst = Math.min(worst, p.contrast);
  console.log(
    c.padEnd(11),
    p.background.padEnd(11),
    String(p.contrast).padStart(7),
    String(icon.length).padStart(6),
    String(art.length).padStart(6),
  );
}

console.log('');
console.log('worst contrast:', worst, worst >= 4.5 ? '(passes WCAG AA)' : '(FAILS WCAG AA)');

const hueOf = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d % 6) : max === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
  return Math.round(((h * 60) + 360) % 360);
};

console.log('');
for (const [a, b] of [['movie', 'theatre'], ['flight', 'rail'], ['rail', 'bus'], ['flight', 'bus']]) {
  const ha = hueOf(derivePalette({ category: a, title: 'Sample' }).background);
  const hb = hueOf(derivePalette({ category: b, title: 'Sample' }).background);
  let gap = Math.abs(ha - hb);
  if (gap > 180) gap = 360 - gap;
  console.log(`${a} vs ${b}`.padEnd(20), `${ha}deg vs ${hb}deg - ${gap}deg apart`, gap >= 40 ? 'OK' : 'TOO CLOSE');
}
