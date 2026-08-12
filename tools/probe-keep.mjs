/**
 * Checks what `keepBarcodeImage` is willing to keep.
 *
 * Two real reports drove this: an ixigo itinerary that showed the whole document when
 * asked for its code, and a forwarded Gmail itinerary that showed the travel agency's
 * logo. Both were accepted on shape alone, so this runs the real module in a real
 * browser against images built to be exactly those things.
 *
 *   node tools/probe-keep.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
};

const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, decodeURIComponent(request.url.split('?')[0].slice(1)) || 'index.html');
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${origin}/index.html`);

const results = await page.evaluate(async (base) => {
  const { keepBarcodeImage } = await import(`${base}/js/barcode.js`);

  const make = (width, height, paint) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    paint(canvas.getContext('2d'), canvas);
    return canvas;
  };

  /** Black bars of random width on white — what a Code 128 actually looks like. */
  const code128 = make(420, 110, (c, canvas) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#000';
    let x = 6;
    let seed = 7;
    while (x < canvas.width - 6) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const bar = 1 + (seed % 4);
      c.fillRect(x, 0, bar, canvas.height);
      seed = (seed * 1103515245 + 12345) % 2147483648;
      x += bar + 1 + (seed % 4);
    }
  });

  /*
   * A dense square of cells — a QR.
   *
   * The generator matters. A linear congruential generator's low bit alternates, so
   * `seed % 2` drew perfectly striped columns that were identical on every row — an
   * image with two transitions a line, which the detector rightly refused. The fixture
   * was wrong, not the code. xorshift has a usable low bit.
   */
  let seed = 123456789;
  const random = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };

  const qr = make(200, 200, (c, canvas) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#000';
    for (let y = 0; y < 25; y++) {
      for (let x = 0; x < 25; x++) {
        if (random() < 0.5) c.fillRect(x * 8, y * 8, 8, 8);
      }
    }
  });

  /** The Thomsons masthead: a wide black rectangle with cyan lettering. */
  const logo = make(380, 108, (c, canvas) => {
    c.fillStyle = '#000';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#29b6d8';
    c.font = 'bold 46px sans-serif';
    c.fillText('thomsons', 18, 62);
    c.fillStyle = '#fff';
    c.beginPath();
    c.moveTo(190, 30); c.lineTo(360, 54); c.lineTo(190, 78); c.closePath();
    c.fill();
  });

  /** A page of text at roughly A4 proportions. */
  const wholePage = make(840, 1040, (c, canvas) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#222';
    c.font = '15px sans-serif';
    for (let y = 40; y < canvas.height - 20; y += 26) {
      c.fillText('ETIHAD AIRWAYS EY Flight Number 8573  CONFIRMED  AKSSPZ', 40, y);
    }
  });

  const check = async (name, canvas, extra = {}) => {
    const kept = await keepBarcodeImage({ barcodeCandidates: [{ canvas, ...extra }] });
    return { name, kept: Boolean(kept) };
  };

  return [
    await check('a Code 128', code128),
    await check('a QR code', qr),
    await check('a travel agency logo', logo),
    await check('a whole page, flagged', wholePage, { wholePage: true }),
    await check('a whole page, unflagged', wholePage),
  ];
}, origin);

const want = {
  'a Code 128': true,
  'a QR code': true,
  'a travel agency logo': false,
  'a whole page, flagged': false,
  'a whole page, unflagged': false,
};

let failed = 0;
for (const { name, kept } of results) {
  const ok = kept === want[name];
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} is ${kept ? 'kept' : 'refused'}${ok ? '' : ` — wanted ${want[name] ? 'kept' : 'refused'}`}`);
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
