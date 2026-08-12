/**
 * Service worker — what makes the app work with no signal.
 *
 * This matters more here than in most apps: a ticket is needed precisely where
 * connectivity fails. On an aeroplane, in a metro tunnel, at a rural bus stand, in a
 * foreign country with no roaming. An app that needs the network to show a barcode has
 * failed at the only moment it was required.
 *
 * So everything is cached on install and served cache-first. The app is entirely static
 * and only a few megabytes; there is no reason to consult the network for it at all.
 *
 * Note what is NOT here: no fetch of user data, no analytics, no background sync, no
 * push. The service worker never sends anything anywhere. It exists solely to make the
 * app's own files available offline.
 */

// Bumping this invalidates every cached file. It must change whenever any asset does,
// or returning users will keep the old app indefinitely.
const VERSION = '3aebb8f';
const CACHE = `ticket-${VERSION}`;

/**
 * Where a shared file waits between the share sheet and the page reading it.
 *
 * Deliberately not versioned, and deliberately excluded from the cleanup in `activate`:
 * a share can arrive at the exact moment a new worker takes over, and a versioned name
 * would have the incoming worker delete the file the outgoing one had just stored.
 */
const SHARE_CACHE = 'ticket-share';
const SHARE_PREFIX = './shared-file-';

/**
 * Everything needed to run.
 *
 * The wasm and worker files are large but non-negotiable: barcode decoding and PDF
 * parsing are the app's core, and downloading them on first use would mean adding a
 * ticket fails offline.
 *
 * **This list is checked by tools/probe-offline.mjs, and must stay in step with the
 * files the app actually loads.** It drifted once already: five modules and two adapters
 * were added over time and never listed here, so the app opened offline to a blank
 * screen — which is worse than failing outright, because it looks like it works right up
 * until the moment it is needed. Run `node tools/probe-offline.mjs` after adding a file.
 */
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',

  './css/app.css',

  './js/app.js',
  './js/store.js',
  './js/ingest.js',
  './js/text.js',
  './js/email.js',
  './js/barcode.js',
  './js/barcode-render.js',
  './js/bcbp.js',
  './js/canvas.js',
  './js/model.js',
  './js/errors.js',
  './js/haptics.js',
  './js/swipe.js',
  './js/snapshot.js',
  // The OCR *module* is tiny and always cached. The engine it loads — about 5.5 MB of
  // WebAssembly and language data under vendor/tesseract/ — deliberately is not: most
  // tickets are PDFs with a text layer and must never pay for it on first open. It is
  // fetched the first time a picture needs reading and cached by the runtime handler
  // below, so it works offline from then on.
  './js/ocr.js',
  './js/tile.js',
  './js/brand.js',
  './js/brand-identity.js',
  './js/build.js',
  './js/artwork.js',
  './js/help.js',
  './js/resume.js',
  './js/settings.js',
  './js/update.js',
  './js/wakelock.js',
  './js/adapters/index.js',
  './js/adapters/registry.js',
  './js/adapters/flight.js',
  './js/adapters/rail.js',
  './js/adapters/event.js',
  './js/adapters/lodging.js',
  './js/adapters/generic.js',
  './js/data/airports.js',

  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
  './vendor/bwip-js.mjs',
  './vendor/bwipp.mjs',
  './vendor/zxing/reader/index.js',
  './vendor/zxing/reader/zxing_reader.wasm',

  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    // Added individually rather than with addAll, because addAll rejects wholesale if a
    // single file 404s — and a service worker that fails to install leaves the app with
    // no offline support at all, silently. One missing icon should not cost that.
    await Promise.all(ASSETS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (error) {
        console.warn('[sw] could not cache', url, error);
      }
    }));

    // Take over at once. The usual objection — that a new worker might serve assets to
    // an old page — does not apply here, since the whole bundle is replaced together.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name !== CACHE && name !== SHARE_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A share arrives as a POST from the system share sheet. It has to be intercepted here,
  // because the site is hosted statically and there is no server to accept the body — left
  // to the network it returns 405 and the share is silently lost. The files are stashed
  // for the page to collect, and the browser is redirected to a plain GET so a reload does
  // not resubmit.
  if (request.method === 'POST' && url.searchParams.get('action') === 'share') {
    event.respondWith(receiveShare(event));
    return;
  }

  if (request.method !== 'GET') return;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) {
      // Refresh in the background so the next launch is current, without ever making
      // this launch wait on the network.
      event.waitUntil(refresh(request));
      return cached;
    }

    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      // Offline and uncached: for a navigation, the app shell is still the right answer,
      // since routing happens client-side.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});

/**
 * Takes the files from a share and parks them where the page can collect them.
 *
 * The Cache API is used rather than IndexedDB because it is reachable from both the
 * worker and the page without sharing a module, and it stores a Response — which carries
 * the file's type and name alongside its bytes, so nothing has to be re-derived.
 *
 * The response is a redirect to a GET, so the share URL never stays in history as a POST
 * that a reload would resubmit.
 */
async function receiveShare(event) {
  const target = new URL('./?action=share', self.location.href);

  try {
    const form = await event.request.formData();
    const files = form.getAll('file').filter((entry) => entry instanceof File && entry.size > 0);

    if (files.length) {
      const cache = await caches.open(SHARE_CACHE);
      // Only the most recent share is kept. Two shares arriving before the page has read
      // either is not a real sequence, and leaving the older one behind would make the
      // app open the wrong ticket.
      await Promise.all((await cache.keys()).map((key) => cache.delete(key)));

      await Promise.all(files.map((file, i) => cache.put(
        new Request(`${SHARE_PREFIX}${i}`),
        new Response(file, {
          headers: {
            'content-type': file.type || 'application/octet-stream',
            'x-stub-filename': encodeURIComponent(file.name || `shared-${i}`),
          },
        }),
      )));
    }
  } catch (error) {
    // A share that cannot be read is still better handled by opening the app than by
    // showing the browser's error page.
    console.warn('[sw] could not read shared files', error);
  }

  return Response.redirect(target.href, 303);
}

async function refresh(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response);
    }
  } catch {
    // Offline is the normal case, not an error worth reporting.
  }
}

// Lets the page trigger an immediate update rather than waiting for a natural reload.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
