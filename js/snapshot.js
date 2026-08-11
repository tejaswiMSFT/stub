/**
 * A picture of the ticket as the app saw it.
 *
 * When a field looks wrong there is currently nothing to check it against — the document
 * is read, its fields extracted, and the file itself discarded. Correcting a seat number
 * then means finding the original PDF in Files, assuming it was kept.
 *
 * So one image is kept: the page, as rendered. Not the file.
 *
 * That distinction is the whole design. The raw PDF is half a megabyte to two megabytes,
 * and iOS evicts a site's storage as a unit when space runs short — it does not choose
 * politely between a barcode and an attachment. A JPEG of the page is a fraction of that
 * and answers the only question anyone actually asks of it: *what did the ticket say?*
 *
 * It is a reference, never a source of truth. Nothing is re-read from it, and the barcode
 * is never taken from it — that remains the bytes decoded at ingest, transplanted
 * unchanged. This is for the human, not for the parser.
 */

/**
 * Longest edge of the stored image.
 *
 * Enough to read a seat number and a name on a phone screen at full zoom, and no more.
 * A ticket is mostly whitespace and 12pt type; storing it at print resolution buys
 * nothing a person can use and costs several times the space.
 */
const MAX_EDGE = 1400;

/** JPEG quality. Above roughly this, size climbs steeply for differences nobody sees. */
const QUALITY = 0.72;

/**
 * Refuse to store anything larger than this.
 *
 * A guard rather than a target: a pathological page could otherwise quietly put a
 * megabyte per ticket into a store the user was promised holds very little. Better to
 * have no snapshot than a snapshot that costs more than the app.
 */
const MAX_BYTES = 700 * 1024;

/**
 * Encodes a canvas as a JPEG data URL, downscaling first if needed.
 *
 * JPEG, not PNG. A rendered page is a photograph of type on paper — continuous tone from
 * antialiasing — which is exactly what JPEG is good at and what PNG is worst at. The same
 * page as PNG runs several times larger for no visible gain. (The barcode image is kept
 * as PNG, correctly: there, every pixel is load-bearing.)
 */
async function encode(canvas, { maxEdge = MAX_EDGE, quality = QUALITY } = {}) {
  const { width, height } = canvas;
  if (!width || !height) return null;

  const scale = Math.min(1, maxEdge / Math.max(width, height));

  let source = canvas;
  if (scale < 1) {
    const { createCanvas } = await import('./canvas.js');
    const target = createCanvas(Math.round(width * scale), Math.round(height * scale));
    const context = target.getContext('2d');
    if (!context) return null;

    // A page of small type downsamples badly with the default filter, and the text is
    // the entire point of keeping it.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(canvas, 0, 0, target.width, target.height);
    source = target;
  }

  const blob = source.convertToBlob
    ? await source.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise((resolve) => source.toBlob(resolve, 'image/jpeg', quality));

  if (!blob) return null;

  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });

  return dataUrl ? { dataUrl, width: source.width, height: source.height, bytes: blob.size } : null;
}

/**
 * Builds the snapshot from an ingested document, or null if there is nothing to show.
 *
 * Emails have no page to photograph — they were read as text — and correctly return null
 * rather than a blank rectangle. The caller must cope with its absence, since a ticket
 * typed in by hand will never have one either.
 */
export async function captureSnapshot(ingested) {
  const canvas = ingested?.displayCanvas;
  if (!canvas?.width) return null;

  try {
    let shot = await encode(canvas);
    if (!shot) return null;

    // One retry, smaller, before giving up. A dense scan can exceed the budget at full
    // size while being perfectly legible at two-thirds of it.
    if (shot.bytes > MAX_BYTES) {
      shot = await encode(canvas, { maxEdge: Math.round(MAX_EDGE * 0.7), quality: 0.62 });
      if (!shot || shot.bytes > MAX_BYTES) return null;
    }

    return {
      image: shot.dataUrl,
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes,
      capturedAt: Date.now(),
    };
  } catch {
    // A tainted canvas or an unsupported encoder. The pass is unaffected: this is a
    // convenience, and losing it must never cost the user their ticket.
    return null;
  }
}

export { MAX_EDGE, MAX_BYTES, QUALITY };
