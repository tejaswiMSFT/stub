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

export function supported() {
  return 'wakeLock' in navigator;
}

export async function acquire() {
  wanted = true;
  if (!supported() || lock) return Boolean(lock);

  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
    return true;
  } catch {
    // Denied, or the tab is not visible. Neither is worth reporting.
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
