/**
 * Renders the shipped mark at the sizes it is actually used at.
 *
 * A mark can be judged only at the size it appears. This draws the real `markSvg` — not a
 * sketch — at app-bar, favicon, home-screen and landing-page sizes, on both light and
 * dark grounds, plus the wordmark and the maskable crop.
 */

import { chromium } from 'playwright';
import { markSvg, wordmarkSvg, brand } from '../js/brand-identity.js';

const INLINE = [16, 20, 26, 32, 44];
const TILES = [48, 72, 108];

function row(label, cells) {
  return `<tr><th>${label}</th>${cells.map((c) => `<td style="text-align:center">${c}</td>`).join('')}</tr>`;
}

function panel(bg, ink) {
  const inline = row('plain, inline',
    INLINE.map((size) => `<span style="color:${ink};display:inline-block;line-height:0">
      ${markSvg({ size, variant: 'plain' })}</span>`));

  const tinted = row('plain, brand',
    INLINE.map((size) => markSvg({ size, variant: 'plain', colour: brand.colour.ink })));

  const tiles = row('app tile',
    TILES.map((size) => `<div style="display:inline-block;border-radius:${(size * 0.225).toFixed(0)}px;
      box-shadow:0 8px 22px rgba(20,16,60,.3)">${markSvg({ size })}</div>`));

  // The maskable icon is what Android crops. A circular clip at the safe-zone diameter
  // shows whether the mark survives the worst launcher shape.
  const masked = row('maskable, circle-cropped',
    TILES.map((size) => `<div style="width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;
      display:inline-block">${markSvg({ size, bleed: 0.22 })}</div>`));

  const words = row('wordmark',
    [22, 34, 48].map((height) => `<span style="color:${ink};display:inline-block;line-height:0">
      ${wordmarkSvg({ height, variant: 'plain' })}</span>`));

  return `<div style="background:${bg};color:${ink};padding:24px 28px;border-radius:18px">
    <table style="border-spacing:22px 18px">
      ${inline}${tinted}${tiles}${masked}${words}
    </table>
  </div>`;
}

const html = `<body style="background:#8a8a8e;margin:0;padding:26px;font-family:system-ui;
  display:flex;flex-direction:column;gap:24px;align-items:flex-start;width:max-content">
  ${panel('#141422', '#ffffff')}
  ${panel('#f4f4f8', '#1c1c1e')}
  <style>th { font: 600 11px system-ui; text-align: left; white-space: nowrap; opacity: .8 }</style>
</body>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 3 });
await page.setContent(html);
await page.locator('body').screenshot({ path: 'tools/_mark-check.png' });
await browser.close();
console.log('wrote tools/_mark-check.png');
