/**
 * Checks the deployed site the way a phone will meet it.
 *
 * Everything so far has been tested against files on disk. A deployment can differ:
 * wrong MIME types, a missing file, a service worker scoped to the wrong path, a
 * manifest that fails to parse. All of those are invisible locally and fatal live.
 *
 *   node tools/probe-live.mjs https://itstejaswi.github.io/stub/
 */

import { chromium, devices } from 'playwright';

const url = process.argv[2] || 'https://itstejaswi.github.io/stub/';

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices['iPhone 13'],
  // Playwright's WebKit-flavoured UA on Chromium is close enough for layout, and the
  // service worker behaviour we care about is Chromium's own.
});
const page = await context.newPage();

const failures = [];
const problems = [];

page.on('response', (response) => {
  if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
});
page.on('pageerror', (error) => problems.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text());
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

const state = await page.evaluate(async () => {
  const registration = await navigator.serviceWorker?.ready
    .then((r) => ({ scope: r.scope, active: Boolean(r.active) }))
    .catch(() => null);

  const manifestHref = document.querySelector('link[rel=manifest]')?.href;
  let manifest = null;
  try {
    manifest = await (await fetch(manifestHref)).json();
  } catch (error) {
    manifest = { error: String(error) };
  }

  return {
    title: document.title,
    themeColor: document.querySelector('meta[name=theme-color]')?.content,
    serviceWorker: registration,
    manifest: manifest?.error ? manifest : {
      name: manifest.name,
      display: manifest.display,
      startUrl: manifest.start_url,
      icons: manifest.icons?.length,
      shareTarget: Boolean(manifest.share_target),
    },
    // What a person actually sees above the fold.
    visible: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 220),
  };
});

console.log(JSON.stringify(state, null, 1));

// Icons must genuinely resolve; a broken one gives a blank home-screen tile.
const icons = await page.evaluate(async () => {
  const manifest = await (await fetch(document.querySelector('link[rel=manifest]').href)).json();
  const results = [];
  for (const icon of manifest.icons || []) {
    const target = new URL(icon.src, document.querySelector('link[rel=manifest]').href).href;
    const response = await fetch(target, { method: 'HEAD' });
    results.push(`${icon.sizes} ${icon.purpose || 'any'} → ${response.status}`);
  }
  return results;
});

console.log('\nicons:\n  ' + icons.join('\n  '));

// Offline, on the deployed origin.
//
// The wait matters. A returning visitor's browser keeps serving the previous service
// worker until the new one has installed and taken over, so checking too early tests
// the old cache and reports a failure that is really just a stale worker.
await page.waitForTimeout(4000);

const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  let count = 0;
  for (const name of names) count += (await (await caches.open(name)).keys()).length;
  return { names, count };
});
console.log(`\ncaches: ${JSON.stringify(cached)}`);

await context.setOffline(true);
const reloaded = await page.reload({ waitUntil: 'domcontentloaded' }).then(() => true).catch(() => false);
const offline = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 120));

console.log(`\noffline reload: ${reloaded ? 'loaded' : 'FAILED'}`);
console.log(`offline content: ${JSON.stringify(offline)}`);

await context.setOffline(false);

if (failures.length) console.log('\nfailed requests:\n  ' + failures.join('\n  '));
else console.log('\nno failed requests');

if (problems.length) console.log('\nerrors:\n  ' + problems.join('\n  '));

await page.screenshot({ path: 'probe-live.png', fullPage: true });
console.log('\nscreenshot: probe-live.png');

await browser.close();
