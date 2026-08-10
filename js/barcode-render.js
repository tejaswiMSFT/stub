/**
 * Barcode rendering.
 *
 * The single most important module in the app, and deliberately the least creative.
 *
 * A barcode is not decoration. It is the thing a scanner reads at a gate, and every
 * liberty taken with it — rounded modules, a logo in the middle, a brand tint, a soft
 * shadow, a fractional scale factor — raises the chance that it fails to read while a
 * queue forms behind its holder. So this module renders pure black on pure white at
 * integer scale with a full quiet zone, and offers no styling options at all. There is
 * nothing here to configure because nothing here should be configured.
 *
 * The payload is the original bytes from the user's own ticket. It is never re-derived
 * from parsed fields, never normalised, never trimmed. Where the source was binary, the
 * bytes are fed through unchanged: a barcode that scans to *different* data than the
 * original is the worst outcome this app can produce, and it would be invisible until
 * the moment it mattered.
 *
 * Screen brightness cannot be raised from a web page — Wallet can do this, we cannot.
 * The compensation is a full-white field, which is why the display surface is white
 * even in dark mode.
 */

import * as bwip from '../vendor/bwip-js.mjs';

/**
 * Symbology names as bwip-js knows them.
 *
 * The mapping is deliberately conservative: an unrecognised format renders nothing and
 * says so, rather than guessing at a similar-looking symbology. A PDF417 drawn as a QR
 * code carries the same data and is useless at the barrier.
 */
const SYMBOLOGY = {
  QRCode: 'qrcode',
  PDF417: 'pdf417',
  Aztec: 'azteccode',
  DataMatrix: 'datamatrix',
  Code128: 'code128',
  Code39: 'code39',
  ITF: 'interleaved2of5',
  EAN13: 'ean13',
  EAN8: 'ean8',
  UPCA: 'upca',
  UPCE: 'upce',
  Codabar: 'rationalizedCodabar',
};

/** Symbologies whose payload may be arbitrary bytes rather than text. */
const BINARY_CAPABLE = new Set(['qrcode', 'pdf417', 'azteccode', 'datamatrix']);

export function symbologyFor(format) {
  return SYMBOLOGY[format] || null;
}

export function isRenderable(format) {
  return Boolean(SYMBOLOGY[format]);
}

/**
 * Recovers the exact payload to encode.
 *
 * Order matters. Raw bytes are preferred over any string, because a string has already
 * been through a decoder and may have lost or substituted bytes. `latin1` is next, since
 * iso-8859-1 maps every byte 0–255 to exactly one character and survives a round trip
 * intact. Plain text is the last resort.
 */
export function payloadOf(barcode) {
  if (!barcode) return null;

  if (barcode.bytes?.length) {
    const bytes = barcode.bytes instanceof Uint8Array ? barcode.bytes : new Uint8Array(barcode.bytes);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { text: binary, binary: true };
  }

  if (barcode.isBinary && typeof barcode.latin1 === 'string') {
    return { text: barcode.latin1, binary: true };
  }

  if (typeof barcode.text === 'string' && barcode.text) {
    return { text: barcode.text, binary: false };
  }

  if (typeof barcode.latin1 === 'string' && barcode.latin1) {
    return { text: barcode.latin1, binary: true };
  }

  return null;
}

/**
 * Draws the barcode onto a canvas.
 *
 * `scale` is forced to a whole number. A fractional scale makes the renderer resample,
 * blurring the boundary between modules — which is precisely the edge a scanner is
 * looking for. Better a slightly smaller sharp code than a larger soft one.
 */
export async function render(canvas, barcode, { targetWidth = 640, maxScale = 12 } = {}) {
  const symbology = symbologyFor(barcode?.format);
  if (!symbology) {
    throw new Error(`We cannot draw a ${barcode?.format || 'barcode'} of that kind.`);
  }

  const payload = payloadOf(barcode);
  if (!payload) throw new Error('This ticket has no barcode data to draw.');

  const options = {
    bcid: symbology,
    text: payload.text,
    scale: 1,
    // Quiet zone. The spec asks for four modules around a QR code and a wider margin for
    // linear symbologies; without it, scanners struggle to find the edge at all.
    paddingwidth: isLinear(symbology) ? 10 : 4,
    paddingheight: isLinear(symbology) ? 4 : 4,
    backgroundcolor: 'FFFFFF',
    barcolor: '000000',
    // No human-readable text: the app prints the reference itself, in a legible face,
    // rather than the cramped rendering the symbology library produces.
    includetext: false,
  };

  // Tells bwip-js the string is byte data rather than characters to be re-encoded.
  if (payload.binary && BINARY_CAPABLE.has(symbology)) {
    options.binarytext = true;
  }

  // Linear codes are drawn taller than the library's default, which is too short to
  // aim at comfortably on a phone held at arm's length.
  if (isLinear(symbology)) options.height = 16;

  // Rendered once at scale 1 to learn the natural module size, then redrawn at the
  // largest whole multiple that fits. Measuring first is what keeps the scale integral.
  const probe = document.createElement('canvas');
  bwip.toCanvas(probe, options);

  const scale = Math.max(1, Math.min(maxScale, Math.floor(targetWidth / probe.width)));
  bwip.toCanvas(canvas, { ...options, scale });

  return {
    width: canvas.width,
    height: canvas.height,
    scale,
    symbology,
    binary: payload.binary,
    // Kept so the UI can prove, if asked, that what is drawn matches the original.
    payloadLength: payload.text.length,
  };
}

function isLinear(symbology) {
  return ['code128', 'code39', 'interleaved2of5', 'ean13', 'ean8', 'upca', 'upce', 'rationalizedCodabar']
    .includes(symbology);
}

/**
 * Confirms that what we drew still decodes to what we were given.
 *
 * Optional, and worth the cost. Everything else in this module is careful, but careful
 * is not the same as verified — and the failure this guards against is silent until
 * someone is standing at a barrier. Reading our own output back closes that gap.
 */
export async function verify(canvas, barcode, readBarcodes) {
  try {
    const results = await readBarcodes(canvas, { tryHarder: true });
    const found = results?.[0];
    if (!found) return { verified: false, reason: 'The drawn code could not be read back.' };

    const expected = payloadOf(barcode);
    const actual = found.latin1 ?? found.text ?? '';
    const wanted = expected.binary ? expected.text : (found.text ?? '');

    if (actual === expected.text || found.text === wanted || found.text === barcode.text) {
      return { verified: true };
    }

    return { verified: false, reason: 'The drawn code does not match the original.' };
  } catch (error) {
    return { verified: false, reason: error.message };
  }
}

/** Human-readable symbology name for the interface. */
export function formatName(format) {
  return {
    QRCode: 'QR code',
    PDF417: 'PDF417',
    Aztec: 'Aztec code',
    DataMatrix: 'Data Matrix',
    Code128: 'Code 128',
    Code39: 'Code 39',
    ITF: 'Interleaved 2 of 5',
  }[format] || format;
}
