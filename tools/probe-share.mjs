/**
 * Proves the share target actually works, end to end.
 *
 * This exists because the feature was declared in the manifest and never implemented. The
 * service worker returned early on anything that was not a GET, so a shared file went to
 * the network and came back 405 from static hosting — and nothing anywhere said so. The
 * app looked like it supported sharing for as long as nobody tried it.
 *
 * Asserting on the code would not have caught that. This drives the real worker in a real
 * browser: register it, POST a real multipart body at the real share URL, and check both
 * that the response redirects to a GET and that the bytes survive into the page.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// The dev server serves a directory index, as production does, so the root is the page.
const PORT = 8742;
const ORIGIN = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT)], {
  // fileURLToPath rather than picking apart `pathname`, which mishandles spaces.
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'ignore',
});

const fail = (message) => {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
};
const pass = (message) => console.log(`ok    ${message}`);

try {
  // Give the server a moment to bind before the first request.
  await sleep(1200);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Nothing here should take long. A default of no timeout turns any mistake in the probe
  // into a hang, which reports nothing at all — the failure mode this file exists to stop.
  page.setDefaultTimeout(20000);

  // Now that the dev server serves a directory index, the site root behaves as it does in
  // production and is the honest thing to load.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 20000 });

  // The worker has to be in control before a POST can be intercepted. Without this the
  // request goes straight to the network and the test measures nothing.
  //
  // The registration object is deliberately not returned: it cannot be serialised across
  // the Playwright boundary, and returning it hangs the call rather than failing it.
  //
  // Both waits are bounded from inside the page. `setDefaultTimeout` does not apply to
  // `evaluate`, so an unresolved promise here would hang the probe indefinitely — which
  // it did, silently, when the page failed to load and no worker ever registered.
  const controlled = await page.evaluate(async () => {
    const withTimeout = (promise, ms) =>
      Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

    const registration = await withTimeout(navigator.serviceWorker.ready, 8000);
    if (!registration) return false;
    if (navigator.serviceWorker.controller) return true;

    return withTimeout(new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true });
    }), 5000).then(() => Boolean(navigator.serviceWorker.controller));
  });

  if (!controlled) {
    fail('service worker never took control — nothing below is meaningful');
    await browser.close();
    server.kill();
    process.exit(1);
  }
  pass('service worker is controlling the page');

  const outcome = await page.evaluate(async () => {
    const body = new FormData();
    body.append('title', 'Boarding pass');
    body.append('file', new File([new Uint8Array([37, 80, 68, 70, 45])], 'pass.pdf', { type: 'application/pdf' }));

    const response = await fetch('./?action=share', { method: 'POST', body });

    // `redirect: follow` is the default, so the browser has already followed the 303 and
    // what arrives here is the destination. A worker that ignored the POST would surface
    // as a 405 or a network error instead.
    const stashed = await caches.open('ticket-share');
    const keys = await stashed.keys();
    const first = keys.length ? await stashed.match(keys[0]) : null;

    return {
      status: response.status,
      ok: response.ok,
      finalUrl: response.url,
      keyCount: keys.length,
      type: first?.headers.get('content-type') || null,
      filename: first ? decodeURIComponent(first.headers.get('x-stub-filename') || '') : null,
      bytes: first ? Array.from(new Uint8Array(await first.arrayBuffer())) : [],
    };
  });

  if (!outcome.ok) fail(`share POST returned ${outcome.status}`);
  else pass(`share POST resolved ${outcome.status} at ${outcome.finalUrl.replace(ORIGIN, '')}`);

  if (outcome.keyCount !== 1) fail(`expected 1 stashed file, found ${outcome.keyCount}`);
  else pass('exactly one file was stashed');

  if (outcome.type !== 'application/pdf') fail(`type lost: ${outcome.type}`);
  else pass('content type survived');

  if (outcome.filename !== 'pass.pdf') fail(`filename lost: ${outcome.filename}`);
  else pass('filename survived');

  const expected = [37, 80, 68, 70, 45];
  if (String(outcome.bytes) !== String(expected)) fail(`bytes changed: ${outcome.bytes}`);
  else pass('bytes are byte-for-byte intact');

  // The page must be able to take the file and leave nothing behind, or every later
  // launch would re-import the same ticket.
  const drained = await page.evaluate(async () => {
    const cache = await caches.open('ticket-share');
    const keys = await cache.keys();
    await Promise.all(keys.map((key) => cache.delete(key)));
    return (await cache.keys()).length;
  });

  if (drained !== 0) fail(`share cache not drainable, ${drained} left`);
  else pass('share cache drains cleanly');

  await browser.close();
} finally {
  server.kill();
}
