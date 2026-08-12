/**
 * Screenshots the real app, on a phone and on a desktop.
 *
 * A mark and a palette can only be judged in place. Rendering them on a contact sheet
 * flatters both: the surrounding chrome, the surfaces they sit against and the size they
 * actually appear at are the things that decide whether they work.
 *
 * Runs against the dev server so it is the shipping app, not a mock.
 */

import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 8744;
const ORIGIN = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'ignore',
});

/**
 * Seeds a few tickets so the home screen shows the list rather than the empty state.
 *
 * Written straight into IndexedDB in the store's own shape. Going through the import flow
 * would be more faithful but needs real files, and this probe is about appearance.
 *
 * Field keys are lower-case and match what the card actually reads — `origin`,
 * `destination`, `service`, `date`. An earlier version of this seed invented `title` and
 * `subtitle`, and every card fell back to the word "Ticket" with no route. That looked
 * exactly like a reported regression and was purely a fault in this file, which is worth
 * remembering: a probe with the wrong fixture accuses the app of its own mistakes.
 */
async function seed(page) {
  await page.evaluate(async () => {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('ticket', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const db = await open();
    const now = Date.now();
    const day = 86400000;
    const iso = (offset) => new Date(now + offset).toISOString().slice(0, 10);

    const records = [
      {
        id: 'seed-flight',
        kind: 'flight',
        transitType: 'air',
        departsAt: now + day * 3,
        addedAt: now,
        originName: 'Kempegowda International',
        destinationName: 'Dubai International',
        fields: {
          origin: 'BLR',
          destination: 'DXB',
          passenger: 'T CHOWDARY',
          service: 'EK 569',
          date: iso(day * 3),
          departureTime: '04:35',
          seat: '14A',
          gate: 'B7',
          reference: 'JKLM4T',
        },
        barcode: { format: 'AZTEC', text: 'M1CHOWDARY/T          EK569 BLRDXB' },
      },
      {
        id: 'seed-rail',
        kind: 'rail',
        transitType: 'rail',
        departsAt: now + day * 9,
        addedAt: now - 1000,
        fields: {
          origin: 'SBC',
          destination: 'MAS',
          passenger: 'T CHOWDARY',
          service: 'Shatabdi 12008',
          date: iso(day * 9),
          departureTime: '06:00',
          coach: 'C4',
          seat: '17',
          reference: '4861644049',
        },
        barcode: { format: 'QR_CODE', text: 'PNR 4861644049' },
      },
      {
        id: 'seed-movie',
        kind: 'movie',
        departsAt: now + day * 1,
        addedAt: now - 2000,
        fields: {
          title: 'Dune: Part Two',
          property: 'PVR Forum Mall',
          screen: '3',
          seats: 'H12, H13',
          date: iso(day),
          departureTime: '21:15',
          reference: '9012773410',
        },
        barcode: { format: 'CODE_128', text: '9012773410' },
      },
    ];

    await new Promise((resolve, reject) => {
      const tx = db.transaction('tickets', 'readwrite');
      const store = tx.objectStore('tickets');
      records.forEach((record) => store.put(record));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  });
}

try {
  await sleep(1200);
  const browser = await chromium.launch();

  // Phone, dark — the app's primary context.
  const phone = await browser.newContext({
    ...devices['iPhone 14 Pro'],
    colorScheme: 'dark',
  });
  const phonePage = await phone.newPage();
  phonePage.setDefaultTimeout(20000);
  await phonePage.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await seed(phonePage);
  await phonePage.reload({ waitUntil: 'load' });
  await sleep(1400);
  await phonePage.screenshot({ path: 'tools/_app-phone-dark.png' });

  // Phone, light — the palette has to hold on white as well.
  const phoneLight = await browser.newContext({
    ...devices['iPhone 14 Pro'],
    colorScheme: 'light',
  });
  const lightPage = await phoneLight.newPage();
  lightPage.setDefaultTimeout(20000);
  await lightPage.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await seed(lightPage);
  await lightPage.reload({ waitUntil: 'load' });
  await sleep(1400);
  await lightPage.screenshot({ path: 'tools/_app-phone-light.png' });

  // Desktop — where the app used to project a phone-width column.
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  const deskPage = await desktop.newPage();
  deskPage.setDefaultTimeout(20000);
  await deskPage.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await seed(deskPage);
  await deskPage.reload({ waitUntil: 'load' });
  await sleep(1400);
  await deskPage.screenshot({ path: 'tools/_app-desktop.png' });

  await browser.close();
  console.log('wrote tools/_app-phone-dark.png, _app-phone-light.png, _app-desktop.png');
} finally {
  server.kill();
}
