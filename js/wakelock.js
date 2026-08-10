/**
 * Keeps the screen awake while a barcode is on show.
 *
 * A phone that sleeps while its owner is holding it out to be scanned is a small
 * humiliation, and it happens constantly: the display timeout is usually thirty seconds
 * and a queue rarely moves that fast.
 *
 * The Wake Lock API is supported on Android and on iOS from 16.4. Where it is absent
 * nothing happens and nothing is said — a missing convenience is not worth an apology,
 * and the barcode is still perfectly visible.
 *
 * The lock is released the moment the barcode is dismissed, and re-acquired if the tab
 * is backgrounded and returns, since the browser drops it silently on visibility change.
 */

let lock = null;
let wanted = false;
let lastError = null;

export function supported() {
  return 'wakeLock' in navigator;
}

/** Why the last attempt failed, for the diagnostics in Settings. */
export function lastFailure() {
  return lastError;
}

export async function acquire() {
  wanted = true;
  if (!supported() || lock) return Boolean(lock);

  // The request is refused outright unless the page is visible, and a page that has just
  // navigated to the scan screen may not have been painted yet. Waiting a frame is the
  // difference between the lock being granted and being silently denied — which is
  // exactly what was happening: supported, wanted, and never acquired.
  if (document.visibilityState !== 'visible') {
    lastError = 'the page was not visible';
    return false;
  }

  try {
    lock = await navigator.wakeLock.request('screen');
    lastError = null;
    lock.addEventListener('release', () => { lock = null; });
    return true;
  } catch (error) {
    // Denied, or the tab is not visible. Recorded rather than discarded, because a
    // setting that claims to keep the screen awake and quietly does not is worse than
    // one that admits it could not.
    lastError = error?.message || String(error);
    lock = null;
    return false;
  }
}

export async function release() {
  wanted = false;
  if (!lock) return;

  try {
    await lock.release();
  } catch {
    // Already gone.
  }
  lock = null;
}

// Browsers drop the lock whenever the page is hidden, and do not restore it. Without
// this, switching apps to check something and coming back leaves the screen dimming
// again at precisely the wrong moment.
if (supported()) {
  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible' && !lock) acquire();
  });
}
