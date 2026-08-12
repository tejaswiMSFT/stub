/**
 * Screenshots the landing page, at the widths people actually arrive on.
 *
 * The landing page is the one screen judged before anything is installed, and the only
 * one with a layout that changes shape rather than merely reflowing. Both the desktop
 * composition and the phone stack have to be looked at, because the phone drawing crosses
 * the seam between two bands and its offset is width-dependent.
 */

import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 8745;
const ORIGIN = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'ignore',
});

/**
 * The landing page is shown only when the app has no tickets and is not installed, so a
 * fresh profile lands there naturally. This asserts it rather than assuming, because a
 * probe that silently screenshots the home screen would look like a landing page failure.
 */
async function assertLanding(page, label) {
  const visible = await page.locator('#screen-landing').isVisible();
  if (!visible) {
    console.error(`FAIL  ${label}: landing screen is not showing`);
    process.exitCode = 1;
  }
}

try {
  await sleep(1200);
  const browser = await chromium.launch();

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const deskPage = await desktop.newPage();
  deskPage.setDefaultTimeout(20000);
  await deskPage.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await sleep(1200);
  await assertLanding(deskPage, 'desktop');
  await deskPage.screenshot({ path: 'tools/_landing-desktop.png', fullPage: true });

  const phone = await browser.newContext({ ...devices['iPhone 14 Pro'] });
  const phonePage = await phone.newPage();
  phonePage.setDefaultTimeout(20000);
  await phonePage.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await sleep(1200);
  await assertLanding(phonePage, 'phone');
  await phonePage.screenshot({ path: 'tools/_landing-phone.png', fullPage: true });

  await browser.close();
  console.log('wrote tools/_landing-desktop.png, _landing-phone.png');
} finally {
  server.kill();
}
