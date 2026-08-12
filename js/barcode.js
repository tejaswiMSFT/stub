/**
 * Barcode reading — symbology-agnostic.
 *
 * A cinema QR and a flight PDF417 arrive here identically; the caller does not care
 * which is which until an adapter interprets the payload. We therefore scan for all
 * ticket-relevant symbologies at once and return every result found, ranked.
 *
 * Reading real tickets is harder than reading a clean test barcode: screenshots are
 * compressed, photographed tickets are skewed and shadowed, and PDF-rendered PDF417
 * can be very wide and thin. The strategy below escalates effort only as needed, so
 * the common case stays fast on a phone.
 */

const ZXING_MODULE = new URL('../vendor/zxing/reader/index.js', import.meta.url).href;
const ZXING_WASM = new URL('../vendor/zxing/reader/zxing_reader.wasm', import.meta.url).href;

/**
 * Symbologies Apple Wallet can display, which is the only set worth finding — a
 * barcode we cannot reproduce in a pass is of no use to the user.
 */
export const WALLET_FORMATS = ['QRCode', 'PDF417', 'Aztec', 'Code128'];

/** Maps zxing's names to Apple's PKBarcodeFormat constants. */
const APPLE_FORMAT = {
  QRCode: 'PKBarcodeFormatQR',
  PDF417: 'PKBarcodeFormatPDF417',
  Aztec: 'PKBarcodeFormatAztec',
  Code128: 'PKBarcodeFormatCode128',
};

let readerPromise = null;

async function loadReader() {
  if (!readerPromise) {
    readerPromise = import(ZXING_MODULE).then(async (lib) => {
      lib.prepareZXingModule({
        overrides: { locateFile: (path) => (path.endsWith('.wasm') ? ZXING_WASM : path) },
        fireImmediately: true,
      });
      return lib;
    });
  }
  return readerPromise;
}

function canvasToImageData(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Boosts local contrast on a greyscale copy.
 *
 * Photographed tickets often have a soft gradient across them from ambient lighting,
 * which defeats a global threshold — one side of the barcode blows out while the
 * other stays muddy. Normalising against the image's own range recovers most of these
 * without the cost of a full adaptive threshold.
 */
function enhanceContrast(imageData) {
  const { data, width, height } = imageData;
  const output = new ImageData(width, height);
  const out = output.data;

  let min = 255;
  let max = 0;
  const grey = new Uint8ClampedArray(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec. 601 luma — closer to perceived brightness than a plain average.
    const value = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    grey[p] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const range = max - min || 1;
  for (let p = 0, i = 0; p < grey.length; p++, i += 4) {
    const stretched = ((grey[p] - min) / range) * 255;
    out[i] = out[i + 1] = out[i + 2] = stretched;
    out[i + 3] = 255;
  }
  return output;
}

/** Inverts — some tickets print light-on-dark, which most decoders reject outright. */
function invert(imageData) {
  const { data, width, height } = imageData;
  const output = new ImageData(width, height);
  const out = output.data;
  for (let i = 0; i < data.length; i += 4) {
    out[i] = 255 - data[i];
    out[i + 1] = 255 - data[i + 1];
    out[i + 2] = 255 - data[i + 2];
    out[i + 3] = 255;
  }
  return output;
}

/**
 * zxing returns bytes for binary payloads and a decoded string for text. BCBP is
 * plain ASCII, but cinema QRs are frequently binary or non-UTF-8, and mangling them
 * would silently produce a pass whose barcode scans to the wrong value at the gate —
 * the single worst failure this tool could have. We therefore keep the raw bytes.
 */
function extractPayload(result) {
  const bytes = result.bytes instanceof Uint8Array ? result.bytes : null;
  const text = typeof result.text === 'string' ? result.text : '';

  let isBinary = false;
  if (bytes && bytes.length) {
    for (const byte of bytes) {
      if (byte === 0 || (byte < 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09)) {
        isBinary = true;
        break;
      }
    }
  }

  return {
    text,
    bytes,
    isBinary,
    /** Latin-1 preserves every byte 1:1, which is what Wallet expects by default. */
    latin1: bytes ? Array.from(bytes, (b) => String.fromCharCode(b)).join('') : text,
  };
}

function scoreResult(result, payload) {
  let score = 0;
  // PDF417 and Aztec carry structured travel data far more often than QR does.
  if (result.format === 'PDF417') score += 30;
  else if (result.format === 'Aztec') score += 20;
  else if (result.format === 'QRCode') score += 15;
  else score += 5;

  // A recognisable IATA record is decisive — nothing else on a ticket looks like this.
  if (/^M[1-9]/.test(payload.text)) score += 60;

  // Longer payloads carry more information; very short ones are usually a decorative
  // QR pointing at the airline's app rather than the ticket itself.
  score += Math.min(20, Math.floor(payload.latin1.length / 25));
  if (payload.latin1.length < 12) score -= 25;

  // A URL is almost always marketing, not the ticket token.
  if (/^https?:\/\//i.test(payload.text) && payload.text.length < 120) score -= 20;

  return score;
}

function toBarcode(result, payload, attempt) {
  const points = Array.isArray(result.position?.topLeft)
    ? result.position
    : result.position || null;

  return {
    format: result.format,
    appleFormat: APPLE_FORMAT[result.format] || null,
    walletCompatible: Boolean(APPLE_FORMAT[result.format]),
    text: payload.text,
    bytes: payload.bytes,
    latin1: payload.latin1,
    isBinary: payload.isBinary,
    eccLevel: result.eccLevel || null,
    position: points,
    /** Which preprocessing pass found it — a proxy for how clean the source was. */
    attempt,
    score: scoreResult(result, payload),
  };
}

/**
 * Symbologies worth decoding, which is a wider set than the ones we can redraw.
 *
 * Restricting detection to the four Wallet formats meant a ticket using anything else —
 * Data Matrix, Code 39, an EAN — was reported as having no barcode at all. Now that a
 * barcode we cannot redraw is kept as a picture instead, there is no reason not to look
 * for it: knowing it is there and showing the original pixels beats denying it exists.
 */
const READABLE_FORMATS = [
  ...WALLET_FORMATS,
  'DataMatrix',
  'Code39',
  'Code93',
  'ITF',
  'EAN-13',
  'EAN-8',
  'UPC-A',
  'UPC-E',
  'Codabar',
  'MaxiCode',
  'MicroQRCode',
];

/**
 * Attempts decoding with escalating effort. Most tickets resolve on the first pass;
 * the later passes exist for photographs and low-quality screenshots and are skipped
 * entirely when they are not needed.
 */
async function runAttempts(reader, imageData, { onProgress } = {}) {
  const base = {
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    formats: READABLE_FORMATS,
    maxNumberOfSymbols: 8,
  };

  const attempts = [
    { name: 'direct', data: imageData, options: base },
    { name: 'contrast', data: null, options: base, transform: enhanceContrast },
    // Downscaling helps when a screenshot was upscaled: interpolation softens module
    // edges, and sampling back down restores a crisper black/white transition.
    { name: 'contrast-pure', data: null, options: { ...base, binarizer: 'GlobalHistogram' }, transform: enhanceContrast },
    { name: 'inverted', data: null, options: base, transform: (d) => invert(enhanceContrast(d)) },
  ];

  const found = new Map();

  for (const attempt of attempts) {
    onProgress?.({ phase: 'barcode', attempt: attempt.name });
    const data = attempt.data || attempt.transform(imageData);

    let results = [];
    try {
      results = await reader.readBarcodes(data, attempt.options);
    } catch {
      continue; // A failed pass is not fatal; later passes may still succeed.
    }

    for (const result of results) {
      if (!result?.isValid && !result?.text && !result?.bytes?.length) continue;
      const payload = extractPayload(result);
      if (!payload.latin1) continue;

      const key = `${result.format}:${payload.latin1}`;
      if (!found.has(key)) found.set(key, toBarcode(result, payload, attempt.name));
    }

    // A high-confidence structured hit means further passes cannot improve matters.
    const best = [...found.values()].sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 75) break;
  }

  return [...found.values()].sort((a, b) => b.score - a.score);
}

/**
 * Reads every ticket-relevant barcode from a rendered canvas.
 *
 * Returns all findings rather than just the best one: a cinema ticket may carry both
 * its real QR and a marketing QR, and letting the user pick beats guessing wrong.
 */
export async function readBarcodes(canvas, options = {}) {
  const reader = await loadReader();
  const imageData = canvasToImageData(canvas);
  const barcodes = await runAttempts(reader, imageData, options);

  return {
    barcodes,
    primary: barcodes[0] || null,
    /** Present but unusable in Wallet — worth telling the user rather than ignoring. */
    unsupported: barcodes.filter((b) => !b.walletCompatible),
    found: barcodes.length > 0,
  };
}

/**
 * Reads barcodes from an ingested source, whatever shape it came in.
 *
 * A PDF or photograph presents one canvas containing everything. An email presents a
 * ranked list of individual images, only one of which is the barcode — so candidates
 * are tried in order and the search stops as soon as something convincing appears,
 * rather than grinding through a masthead and six social icons on a phone.
 */
/**
 * How long the whole barcode search may take.
 *
 * Twelve seconds is long enough to try the page and several tiles on a phone, and short
 * enough that someone at a gate does not think the app has hung. The alternative was
 * measured at 159 seconds.
 */
const BARCODE_BUDGET_MS = 12000;

export async function readBarcodesFromSource(ingested, options = {}) {
  const candidates = ingested?.barcodeCandidates?.length
    ? ingested.barcodeCandidates
    : (ingested?.barcodeCanvas ? [{ canvas: ingested.barcodeCanvas, scale: ingested.barcodeScale || 1 }] : []);

  if (!candidates.length) {
    return { barcodes: [], primary: null, unsupported: [], found: false, searched: 0 };
  }

  const all = new Map();
  let searched = 0;

  /*
   * A budget, because the search must not be able to run away.
   *
   * Measured, not guessed: a 3072×4080 phone photograph of a cinema ticket spent **two
   * and a half minutes** here, ninety-five per cent of the whole ingest, while OCR — the
   * stage everyone assumes is slow — took six seconds. Nine tiles of a very large image
   * is simply a great deal of work, and no amount of it helps if the code is not there.
   *
   * The cheap candidates come first, so a budget mostly ends a search that was going to
   * fail anyway. A ticket whose barcode is found in the first attempt never notices this.
   */
  const budget = options.budgetMs ?? BARCODE_BUDGET_MS;
  const started = Date.now();

  for (const candidate of candidates) {
    // Always try the first candidate, however slow the device: giving up before looking
    // once would be worse than the delay.
    if (searched > 0 && Date.now() - started > budget) break;

    searched++;
    options.onProgress?.({ phase: 'barcode-candidate', index: searched, of: candidates.length });

    // A candidate may be drawn on demand rather than held. Nine upscaled tiles of a page
    // at decoding resolution is far too much memory to keep at once on a phone, and the
    // first one usually answers — so a tile is painted when it is reached and released
    // as soon as it has been read.
    const drawn = candidate.canvas ? { canvas: candidate.canvas } : candidate.draw?.();
    if (!drawn?.canvas) continue;

    const { barcodes } = await readBarcodes(drawn.canvas, options);

    if (!candidate.canvas && drawn.canvas) {
      // Freeing the backing store immediately, rather than waiting on the collector,
      // is what keeps a nine-tile sweep from being the thing that gets the tab killed.
      drawn.canvas.width = 0;
      drawn.canvas.height = 0;
    }

    for (const barcode of barcodes) {
      const key = `${barcode.format}:${barcode.latin1}`;
      if (!all.has(key)) {
        // Where the barcode sat in the source, so the review screen can point at it.
        all.set(key, candidate.region ? { ...barcode, sourceRegion: candidate.region } : barcode);
      }
    }

    const best = [...all.values()].sort((a, b) => b.score - a.score)[0];

    /*
     * Stop once the ticket has plainly been found.
     *
     * The score threshold alone was unreachable for a QR code. Scoring caps at 15 for the
     * symbology plus 20 for length, so a QR maxes out at 35 against a threshold of 40 —
     * meaning every QR ticket searched all ten candidates however early it was found.
     * Measured on an IRCTC slip: the code decodes on the first candidate in 2.4 seconds,
     * and the search then spent a further nine seconds confirming there was nothing else.
     * On a phone that is the difference between prompt and apparently hung.
     *
     * QR is scored low deliberately, because a QR is often decoration where a PDF417
     * never is — so the length test does the work instead. A payload of this size is a
     * token, not a link to an app store, and anything that *is* a link is excluded
     * outright.
     */
    const decisive = best?.walletCompatible && (
      best.score >= 40
      || (best.latin1.length >= 60 && !/^https?:\/\//i.test(best.text))
    );
    if (decisive) break;
  }

  const barcodes = [...all.values()].sort((a, b) => b.score - a.score);
  return {
    barcodes,
    primary: barcodes[0] || null,
    unsupported: barcodes.filter((b) => !b.walletCompatible),
    found: barcodes.length > 0,
    searched,
  };
}

/**
 * Converts a decoded barcode into the `barcodes` entry Wallet expects.
 *
 * Encoding matters more than it appears: Wallet re-encodes `message` when it draws
 * the barcode, so a payload round-tripped through the wrong charset scans to
 * different bytes than the original. iso-8859-1 maps every byte 0–255 to exactly one
 * character, so binary payloads survive intact.
 */
export function toWalletBarcode(barcode, { altText } = {}) {
  if (!barcode?.walletCompatible) return null;

  const useLatin1 = barcode.isBinary || barcode.latin1 !== barcode.text;

  return {
    format: barcode.appleFormat,
    message: useLatin1 ? barcode.latin1 : barcode.text,
    messageEncoding: useLatin1 ? 'iso-8859-1' : 'utf-8',
    ...(altText ? { altText } : {}),
  };
}

/**
 * Keeps a picture of a barcode that could not be decoded.
 *
 * Decoding and preserving are different problems, and failing the first should not throw
 * away the second. A gate scanner reads pixels; it neither knows nor cares whether we
 * understood them. So when a barcode is visibly present but will not decode — a low
 * resolution scan, an unusual symbology, a damaged print — the original image is kept
 * and shown as it is.
 *
 * This honours the never-regenerate rule better than the alternative, which was to show
 * nothing at all. These are literally the original pixels, not a re-encoding of anything.
 *
 * Only candidates shaped like a barcode are considered: a square for a 2D code, or a
 * wide stripe for a 1D one. A photograph or a logo is neither.
 */
export async function keepBarcodeImage(ingested) {
  const candidates = (ingested?.barcodeCandidates || [])
    /*
     * Never the whole page.
     *
     * The page render is in the candidate list because the decoder needs something to
     * try when no smaller image was found. It is not a picture of a barcode, and keeping
     * it produced exactly that: tapping "Show the code" filled the screen with the
     * entire ixigo itinerary — every field on it, including the passengers' names and
     * the PNR — where a barcode should have been.
     *
     * Shape alone did not catch it. `barcodeShapeScore` calls anything between 0.8 and
     * 1.25 a square 2D code, and that itinerary's page is 0.81 — so the whole document
     * scored ~90 and beat the real barcodes on it, which are wide stripes scoring ~60.
     * The page was not merely accepted; it won.
     *
     * Tiles are already excluded by the filter below, having no canvas of their own.
     */
    .filter((candidate) => !candidate?.wholePage)
    .filter((candidate) => candidate?.canvas?.width);

  if (!candidates.length) return null;

  const scored = candidates
    .map((candidate) => ({ candidate, score: barcodeShapeScore(candidate.canvas) }))
    .filter((entry) => entry.score > 0)
    // Shape gets a candidate considered; ink decides whether it is kept.
    .filter((entry) => looksLikeInk(entry.candidate.canvas))
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.candidate;
  if (!best) return null;

  try {
    const blob = best.canvas.convertToBlob
      ? await best.canvas.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve) => best.canvas.toBlob(resolve, 'image/png'));

    if (!blob) return null;

    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });

    if (!dataUrl) return null;

    return {
      image: dataUrl,
      width: best.canvas.width,
      height: best.canvas.height,
      /** Never decoded, so there is no payload to claim — only the picture. */
      decoded: false,
    };
  } catch {
    return null;
  }
}

/**
 * Whether a candidate is printed like a barcode, judged on its pixels.
 *
 * Shape is not enough, and a travel agency's masthead proved it. The Thomsons logo on a
 * forwarded Gmail itinerary is a wide black rectangle — ratio about 3.5, comfortably
 * inside the "wide stripe" band — so it scored as a Code 128 and was kept. Tapping
 * "Show the code" presented the traveller with a company logo to hold up at a gate on a
 * document that carries no barcode at all.
 *
 * Three properties separate ink from artwork, and a barcode has all three:
 *
 *   Colourless. Bars are black on white. The logo is cyan on black, and any coloured
 *     pixel at all is disqualifying — no symbology has ever been printed in two hues.
 *
 *   Bimodal. Pixels sit at the ends of the range, not in the middle. Antialiasing puts a
 *     thin grey fringe on every edge, so a modest share of mid-tones is expected; a
 *     photograph or a gradient is mostly mid-tone.
 *
 *   Busy, and evenly so. A scanline crosses many light-dark boundaries, because that is
 *     what encodes the payload — and crucially, *every* scanline does, because a barcode
 *     is uniform down its height. This is what separates a barcode from a page of text,
 *     which is also black, also colourless, and also full of transitions: measured, a
 *     Code 128 crosses 406 boundaries on every single row, while a page of text ranges
 *     from 0 on the gaps between lines to 152 on the text, with a median of 2. A QR sits
 *     at 11 to 21, low but perfectly even. So the test is the median and the evenness,
 *     never the total — a mean is dragged up by the text rows and lets a page through.
 *
 * Rows are sampled rather than every pixel: a barcode is uniform down its height, so
 * thirty-two scanlines answer the question as well as a thousand and cost nothing.
 */
function looksLikeInk(canvas) {
  let data;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return true;
    data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    // A tainted or unreadable canvas tells us nothing either way. Shape already had to
    // pass, so the candidate is admitted rather than a real barcode being discarded.
    return true;
  }

  const { width, height } = canvas;
  const step = Math.max(1, Math.floor(height / Math.min(32, height)));

  let sampled = 0;
  let coloured = 0;
  let midtone = 0;
  const crossings = [];

  for (let y = 0; y < height; y += step) {
    let previous = null;
    let count = 0;

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      // Transparent pixels are the page showing through, not ink.
      if (data[i + 3] < 16) continue;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      sampled++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 40) coloured++;

      const luma = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      if (luma > 0.25 && luma < 0.75) midtone++;

      const dark = luma < 0.5;
      if (previous !== null && dark !== previous) count++;
      previous = dark;
    }

    crossings.push(count);
  }

  if (!sampled || !crossings.length) return false;

  if (coloured / sampled > 0.02) return false;
  if (midtone / sampled > 0.35) return false;

  const sorted = [...crossings].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // The smallest QR measured 11 crossings a row, so the floor sits below that with room
  // to spare. Anything at or under a handful is a rule, a logo or a line of prose.
  if (median < 6) return false;

  // And nearly every row must carry them. A page of text manages this on barely half its
  // rows, the rest being the white space between lines.
  const busy = crossings.filter((count) => count >= Math.max(4, median * 0.35)).length;
  return busy / crossings.length >= 0.75;
}

/**
 * How much a candidate looks like a barcode rather than a photograph or a logo.
 *
 * Shape is the only signal available without decoding, but it is a good one: 2D codes
 * are square, 1D codes are wide stripes, and neither is a portrait or a masthead.
 */
function barcodeShapeScore(canvas) {
  const { width, height } = canvas;
  if (!width || !height) return 0;

  // Too small to carry a payload at all.
  if (width < 80 || height < 30) return 0;

  const ratio = width / height;

  // Square-ish: QR, Aztec, Data Matrix.
  if (ratio > 0.8 && ratio < 1.25) return 100 - Math.abs(1 - ratio) * 50;

  // A wide stripe: Code 128, PDF417.
  if (ratio > 2 && ratio < 9 && height >= 40) return 60 - Math.abs(4 - ratio) * 4;

  return 0;
}

/** Human-readable symbology name for the UI. */
export function formatLabel(format) {
  return { QRCode: 'QR code', PDF417: 'PDF417', Aztec: 'Aztec', Code128: 'Code 128' }[format] || format;
}
