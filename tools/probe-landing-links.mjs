/**
 * Checks the landing page's links and its one in-app button.
 *
 * The install guide is a button rather than an anchor — it opens a screen inside the app,
 * which has no URL of its own — so nothing about it is verified by loading the page. It
 * was also easy to get wrong: the guide already existed but was reachable only from the
 * app bar, which is to say only after installing, which is when it is no longer needed.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 8746;
const ORIGIN = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'ignore',
});

const fail = (message) => { console.error(`FAIL  ${message}`); process.exitCode = 1; };
const pass = (message) => console.log(`ok    ${message}`);

try {
  await sleep(1200);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);

  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await sleep(900);

  // The outbound links: checked for their targets rather than followed, since this runs
  // without a network and the destinations are not ours to depend on in a test.
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('.landing-links a'))
    .map((a) => ({ text: a.textContent.trim(), href: a.href, target: a.target, rel: a.rel })));

  const contact = links.find((l) => /contact/i.test(l.text));
  if (!contact) fail('no contact link');
  else if (!contact.href.includes('tejaswimsft.github.io/#contact')) fail(`contact points at ${contact.href}`);
  else if (!contact.rel.includes('noopener')) fail('contact link is missing rel=noopener');
  else pass(`contact → ${contact.href}`);

  const source = links.find((l) => /source/i.test(l.text));
  if (!source) fail('no source link');
  else if (!source.href.includes('github.com/tejaswiMSFT/stub')) fail(`source points at ${source.href}`);
  else pass(`source → ${source.href}`);

  // The install guide has to actually open the help screen, on the first page.
  const guide = page.locator('#landing-help');
  if (!(await guide.count())) {
    fail('no install guide button');
  } else {
    await guide.click();
    await sleep(600);

    const state = await page.evaluate(() => ({
      helpVisible: !document.getElementById('screen-help').hidden,
      title: document.getElementById('help-title')?.textContent?.trim(),
      landingHidden: document.getElementById('screen-landing').hidden,
    }));

    if (!state.helpVisible) fail('install guide did not open the help screen');
    else pass(`install guide opens help, showing "${state.title}"`);

    if (state.title !== 'Install') fail(`help opened on "${state.title}", not Install`);
    else pass('help opens on the Install page');

    // Back has to return to the landing page, not the home screen — a visitor who has not
    // installed anything has no tickets to return to.
    await page.locator('#help-close').click();
    await sleep(600);
    const returned = await page.evaluate(() => !document.getElementById('screen-landing').hidden);
    if (!returned) fail('back from help did not return to the landing page');
    else pass('back returns to the landing page');
  }

  await browser.close();
} finally {
  server.kill();
}
