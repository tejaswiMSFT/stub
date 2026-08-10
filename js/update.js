/**
 * Keeping the app up to date without ever getting in the way.
 *
 * A web app has no App Store, which is mostly a blessing: a fix reaches everyone the
 * moment it is pushed, with nobody waiting on review. The cost is that a service worker
 * serves from cache first, so an installed copy can happily run last month's code
 * forever — and the only way to find out is to ask someone to try it again.
 *
 * **What this deliberately does not do is block.**
 *
 * The obvious design — refuse to run until the user updates — is wrong for this app in
 * particular. Its entire purpose is to show a ticket at a barrier, and an update needs
 * the network, which is exactly what is missing on a plane, in a tunnel, or abroad.
 * Locking someone out of their boarding pass because a newer version exists would be a
 * far worse failure than the bug being fixed. A ticket app must show the ticket.
 *
 * So instead:
 *
 *   1. Check quietly on launch, and again whenever the app is brought back to the
 *      foreground. An installed PWA can sit suspended for weeks; without this it may
 *      never look.
 *   2. Let the service worker fetch the new version in the background. Nothing changes
 *      on screen while that happens.
 *   3. Apply it at a moment that costs the user nothing — when the app is backgrounded,
 *      or on the next launch. Reloading while someone is holding their phone up to a
 *      scanner is unthinkable.
 *   4. If the app stays open and in use, mention it once, quietly, and let them choose.
 *
 * Saved tickets are untouched by any of this. The service worker caches the app's own
 * files; tickets live in IndexedDB. They are separate stores, and updating one cannot
 * affect the other — an upgrade never costs the user their passes.
 */

/** How often to look while the app is open. Hourly is plenty for a static site. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Ignore a resume that happens moments after the last check. */
const RESUME_THROTTLE_MS = 5 * 60 * 1000;

let registration = null;
let lastCheck = 0;
let pending = false;
let onReady = null;
let applying = false;

/**
 * Whether it is safe to reload right now.
 *
 * Supplied by the app, because only it knows whether a barcode is currently on screen
 * being scanned. Defaults to "no" so that a missing answer is the cautious one.
 */
let isSafeToReload = () => false;

export function configure({ safeToReload, onUpdateReady }) {
  if (typeof safeToReload === 'function') isSafeToReload = safeToReload;
  if (typeof onUpdateReady === 'function') onReady = onUpdateReady;
}

export async function start() {
  if (!('serviceWorker' in navigator)) return null;

  try {
    registration = await navigator.serviceWorker.register('./sw.js');
  } catch (error) {
    // Offline support is a bonus, not a requirement; the app still works without it.
    console.warn('Service worker registration failed', error);
    return null;
  }

  // A worker already waiting means an update arrived on a previous visit and was never
  // applied — the commonest case, and the one that leaves people on stale code.
  if (registration.waiting) announce();

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;

    installing.addEventListener('statechange', () => {
      // "installed" with an existing controller means a *new* version is ready. Without
      // a controller it is simply the first install, which is not an update.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) announce();
    });
  });

  // The new worker has taken over: the page must reload to actually run its code.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!applying) return;
    applying = false;
    window.location.reload();
  });

  check();
  setInterval(check, CHECK_INTERVAL_MS);

  // An installed app is usually resumed, not launched. Without this it could run old
  // code indefinitely, because nothing ever prompts the browser to look.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      check();
      return;
    }

    // Going away is the perfect moment: applying now means the next launch is already
    // the new version, with no reload the user ever sees.
    if (pending) apply();
  });

  return registration;
}

/** Asks the browser whether a newer version exists. Silent either way. */
export async function check({ force = false } = {}) {
  if (!registration) return false;

  const now = Date.now();
  if (!force && now - lastCheck < RESUME_THROTTLE_MS) return pending;
  lastCheck = now;

  try {
    await registration.update();
  } catch {
    // Offline, or the server is unreachable. Neither is worth mentioning: the app works
    // perfectly well on the version it already has, which is the entire point.
  }

  return pending;
}

function announce() {
  if (pending) return;
  pending = true;

  // Applying immediately is free when nothing is on screen that matters.
  if (isSafeToReload()) {
    apply();
    return;
  }

  onReady?.();
}

/**
 * Switches to the new version.
 *
 * The waiting worker is told to take over; `controllerchange` then reloads the page.
 * Tickets are in IndexedDB and are not touched.
 */
export function apply() {
  if (!registration?.waiting) {
    // Nothing waiting: a plain reload picks up whatever is current.
    if (pending) window.location.reload();
    return;
  }

  applying = true;
  registration.waiting.postMessage('skip-waiting');
}

/** Whether a new version is downloaded and waiting. */
export function isPending() {
  return pending;
}

/**
 * Remembers which build the user last saw, so the app can tell them when it changes.
 *
 * Updating silently is the right behaviour — it never interrupts, and it means a fix
 * reaches people without anyone being asked to try again. But an app that changes under
 * someone without a word is unsettling: a button moves, a screen looks different, and
 * they are left wondering whether they did something. Saying so afterwards costs one
 * line and turns a surprise into a courtesy.
 *
 * localStorage rather than IndexedDB: this is a single short string, it is not the
 * user's data, and it must be readable synchronously during the first render.
 */
const SEEN_KEY = 'stub:last-seen-build';

/**
 * The build the user has just arrived on, if it differs from the one they last saw.
 * Returns null on a first run — someone opening the app for the first time has not
 * "been updated" and should not be told they have.
 */
export function consumeUpdatedFrom(currentVersion) {
  let previous = null;
  try {
    previous = localStorage.getItem(SEEN_KEY);
    localStorage.setItem(SEEN_KEY, currentVersion);
  } catch {
    // Private browsing can refuse storage. Not worth a word to the user.
    return null;
  }

  if (!previous || previous === currentVersion) return null;
  return previous;
}
