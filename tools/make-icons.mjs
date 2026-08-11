/**
 * Renders the app icons from the single brand definition.
 *
 * The mark lives in js/brand-identity.js and nowhere else; this script only rasterises
 * it. An earlier version redrew the shape by hand in a software rasteriser, which meant
 * two definitions of the same artwork that could — and did — drift apart.
 *
 * Rendering is done through a headless browser rather than a native image library.
 * Every such library (canvas, sharp, resvg) needs compilation, which is a heavy price
 * for six PNGs in a project whose whole argument is that it depends on very little.
 * The browser is already present for testing, renders SVG exactly as the app will, and
 * costs nothing extra.
 *
 * Output is committed, so a checkout works without running this.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

import { markSvg, wordmarkSvg, brand } from '../js/brand-identity.js';

const TARGETS = [
  { file: 'icon-192.png', size: 192, bleed: 0.155 },
  { file: 'icon-512.png', size: 512, bleed: 0.155 },
  { file: 'icon-1024.png', size: 1024, bleed: 0.155 },
  // iOS applies its own rounding, so the artwork stays square.
  { file: 'apple-touch-icon.png', size: 180, bleed: 0.155 },
  // Maskable: Android crops to whatever shape the launcher prefers, so the mark needs
  // far more room or it loses its corners to a circular mask.
  { file: 'icon-maskable-192.png', size: 192, bleed: 0.26 },
  { file: 'icon-maskable-512.png', size: 512, bleed: 0.26 },
];

await mkdir(new URL('../icons/', import.meta.url), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

for (const target of TARGETS) {
  const svg = markSvg({ size: target.size, variant: 'app', bleed: target.bleed, full: true });

  await page.setViewportSize({ width: target.size, height: target.size });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}</style>${svg}`,
    { waitUntil: 'load' },
  );

  const png = await page.screenshot({ omitBackground: true, type: 'png' });
  await writeFile(new URL(`../icons/${target.file}`, import.meta.url), png);
  console.log('wrote', target.file.padEnd(26), `${target.size}x${target.size}`, String(png.length).padStart(6), 'bytes');
}

await browser.close();

// The vector forms, for the site itself — sharp at any size and a fraction of the weight.
await writeFile(new URL('../icons/mark.svg', import.meta.url), markSvg({ size: 512, variant: 'app' }));
await writeFile(new URL('../icons/mark-plain.svg', import.meta.url), markSvg({ size: 512, variant: 'plain', colour: brand.colour.ink }));
await writeFile(new URL('../icons/wordmark.svg', import.meta.url), wordmarkSvg({ height: 44 }));
console.log('wrote mark.svg, mark-plain.svg, wordmark.svg');
