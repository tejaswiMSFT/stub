/**
 * Shows the icon where it is actually judged: on a home screen, among other apps.
 *
 * Every preview so far has put the icon on a flat panel, which answers the wrong
 * question. A white tile on a dark panel looks like a white tile on a dark panel; it says
 * nothing about whether the icon holds against a photograph, or reads next to a dozen
 * neighbours competing for the same glance.
 *
 * The wallpapers are generated gradients rather than photographs — no image is committed
 * to the repository for a preview — but they cover the cases that matter: bright, dark,
 * and busy with colour close to the mark's own.
 */

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const icon = `data:image/png;base64,${(await readFile(new URL('../icons/icon-512.png', import.meta.url))).toString('base64')}`;

/**
 * Neighbouring icons, so the mark is judged in competition rather than alone.
 *
 * Deliberately plain: flat tiles in the colours common on a home screen. Anything more
 * detailed would draw the eye and flatter our own icon by comparison.
 */
const NEIGHBOURS = [
  { name: 'Mail', bg: 'linear-gradient(160deg,#3aa0ff,#0a6fd8)', glyph: '✉' },
  { name: 'Maps', bg: 'linear-gradient(160deg,#5fd07a,#1f9d55)', glyph: '➤' },
  { name: 'Music', bg: 'linear-gradient(160deg,#ff6a7a,#e02040)', glyph: '♪' },
  { name: 'Photos', bg: 'linear-gradient(160deg,#ffd166,#f08c1c)', glyph: '✿' },
  { name: 'Notes', bg: 'linear-gradient(160deg,#ffe27a,#f0b429)', glyph: '≡' },
  { name: 'Files', bg: 'linear-gradient(160deg,#7f8c9b,#4a5560)', glyph: '▤' },
  { name: 'Clock', bg: 'linear-gradient(160deg,#2c2c34,#0e0e12)', glyph: '◷' },
];

const WALLPAPERS = [
  {
    label: 'dark wallpaper',
    css: 'radial-gradient(120% 90% at 22% 12%, #2a2350 0%, #14122b 42%, #07070f 100%)',
    ink: '#ffffff',
  },
  {
    label: 'light wallpaper',
    css: 'radial-gradient(120% 90% at 25% 15%, #ffffff 0%, #e8e6f5 48%, #cfd4e6 100%)',
    ink: '#1a1a24',
  },
  {
    label: 'busy, close to the mark in colour',
    css: 'linear-gradient(140deg, #6b4fd8 0%, #a03fb0 34%, #4a3ec8 68%, #2a1f6b 100%)',
    ink: '#ffffff',
  },
];

/** One home screen: our icon first, then neighbours, at a realistic tile size. */
function screen({ label, css, ink }) {
  const tile = 62;

  const ours = `
    <div style="text-align:center">
      <img src="${icon}" width="${tile}" height="${tile}"
           style="display:block;border-radius:${(tile * 0.225).toFixed(1)}px;
             box-shadow:0 6px 16px rgba(0,0,0,.34)">
      <div style="font:500 10px system-ui;color:${ink};margin-top:6px;
        text-shadow:0 1px 3px rgba(0,0,0,.5)">Stub</div>
    </div>`;

  const others = NEIGHBOURS.map((app) => `
    <div style="text-align:center">
      <div style="width:${tile}px;height:${tile}px;border-radius:${(tile * 0.225).toFixed(1)}px;
        background:${app.bg};display:flex;align-items:center;justify-content:center;
        color:#fff;font-size:${tile * 0.4}px;box-shadow:0 6px 16px rgba(0,0,0,.34)">${app.glyph}</div>
      <div style="font:500 10px system-ui;color:${ink};margin-top:6px;
        text-shadow:0 1px 3px rgba(0,0,0,.5)">${app.name}</div>
    </div>`).join('');

  return `
  <div style="width:300px;border-radius:26px;overflow:hidden;background:${css};
    padding:22px 18px 26px;box-shadow:0 18px 44px rgba(0,0,0,.4)">
    <div style="font:600 10px system-ui;color:${ink};opacity:.55;margin-bottom:16px">${label}</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:18px 12px">
      ${ours}${others}
    </div>
  </div>`;
}

const html = `<body style="background:#8a8a8e;margin:0;padding:24px;font-family:system-ui;
  display:flex;gap:20px;align-items:flex-start;width:max-content">
  ${WALLPAPERS.map(screen).join('')}
</body>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 3 });
await page.setContent(html);
await page.locator('body').screenshot({ path: 'tools/_home-screen.png' });
await browser.close();
console.log('wrote tools/_home-screen.png');
