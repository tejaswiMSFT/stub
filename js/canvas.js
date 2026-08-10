/**
 * One canvas factory, shared.
 *
 * Four modules each decided independently whether `OffscreenCanvas` was available, and
 * all four asked the same wrong question: *does the constructor exist?* On iOS Safari it
 * can exist while being unusable for what we do with it, and the app then failed on
 * every PDF with "undefined is not a function". Desktop WebKit has no OffscreenCanvas at
 * all, so it took the DOM path and worked — which is precisely why the bug survived
 * testing.
 *
 * The capability is probed once, by doing the things the app actually does, and the
 * answer cached. A DOM canvas works everywhere and is the safe default; the offscreen
 * one is only an optimisation, and losing it costs nothing a user would notice.
 */

let usable = null;

/** Whether OffscreenCanvas can do everything this app asks of a canvas. */
export function canUseOffscreenCanvas() {
  if (usable !== null) return usable;

  usable = false;
  try {
    if (typeof OffscreenCanvas === 'undefined') return usable;

    const probe = new OffscreenCanvas(2, 2);
    const context = probe.getContext('2d', { willReadFrequently: true });

    if (!context
      || typeof context.drawImage !== 'function'
      || typeof context.getImageData !== 'function') {
      return usable;
    }

    // Reading pixels back is the operation most likely to be missing or to throw, and
    // the one both barcode decoding and logo extraction depend on.
    context.getImageData(0, 0, 1, 1);

    usable = true;
  } catch {
    usable = false;
  }

  return usable;
}

/** A canvas of the given size, offscreen where that is genuinely supported. */
export function createCanvas(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  if (canUseOffscreenCanvas()) return new OffscreenCanvas(w, h);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/**
 * Frees a canvas's backing store.
 *
 * Setting the dimensions to zero releases the memory immediately rather than waiting for
 * the collector, which matters on a phone holding a page rendered at decoding
 * resolution. An OffscreenCanvas may refuse a zero dimension, so this never throws:
 * tidying up must not be able to fail work that has already succeeded.
 */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Nothing to do; the collector will get there.
  }
}
