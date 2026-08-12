/**
 * Ingestion — turns whatever the user hands us into a uniform internal shape.
 *
 * Five input paths converge here:
 *   1. PDF with a real text layer   → precise positioned text
 *   2. Image (JPG/PNG/HEIC/WebP)    → rendered directly, OCR for text
 *   3. PDF wrapping a scanned image → parses cleanly but yields no text; the
 *      dangerous case, because it silently produces an empty form unless detected
 *   4. Email (.eml, .mhtml, or a pasted message body) → laid out and read as text,
 *      with the barcode taken from whichever inline image actually holds it
 *   5. Plain-text mail              → no layout, but often a complete ticket
 *
 * Paths 4 and 5 matter more than they first appear: a great many tickets are never
 * a file at all. They are an email body with the QR inline, and the only way to
 * carry one today is a screenshot buried in a camera roll.
 *
 * Everything downstream consumes the same `Ingested` shape regardless of source,
 * so adapters never need to know where the data came from — only how much to
 * trust it, which travels with each value as a confidence tier.
 */

import { IngestError } from './errors.js';
import { createCanvas as makeCanvas } from './canvas.js';
import { tileCandidates } from './tile.js';
import {
  parseMessage,
  providerFromSender,
  layoutHtml,
  rankBarcodeCandidates,
  imageToCanvas,
  itemsFromPlainText,
  looksLikeMessage,
  looksLikeHtml,
} from './email.js';

const PDF_WORKER_SRC = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const PDF_SRC = new URL('../vendor/pdf.min.mjs', import.meta.url).href;

/** Rendering above the source resolution helps barcode decoding on small screenshots. */
const BARCODE_RENDER_SCALE = 3;
const DISPLAY_RENDER_SCALE = 2;
/** Beyond this the canvas cost outweighs the accuracy gain on mobile. */
const MAX_RENDER_PIXELS = 4_000_000;

let pdfjsPromise = null;

/** pdf.js is ~440 KB, so it loads only once a PDF actually arrives. */
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDF_SRC).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
      return lib;
    });
  }
  return pdfjsPromise;
}

export const SourceKind = {
  PDF_TEXT: 'pdf-text',
  PDF_SCANNED: 'pdf-scanned',
  IMAGE: 'image',
  EMAIL_HTML: 'email-html',
  EMAIL_TEXT: 'email-text',
};

export { IngestError };

function clampScale(width, height, scale) {
  const pixels = width * height * scale * scale;
  if (pixels <= MAX_RENDER_PIXELS) return scale;
  return Math.max(1, scale * Math.sqrt(MAX_RENDER_PIXELS / pixels));
}

/**
 * A canvas to draw on.
 *
 * See js/canvas.js — the choice between an offscreen and a DOM canvas is probed there
 * once, because asking whether `OffscreenCanvas` merely *exists* was the bug that broke
 * every PDF on iOS Safari.
 */
function createCanvas(width, height) {
  return makeCanvas(width, height);
}

/**
 * Reads a page's text, without relying on async iteration over a stream.
 *
 * pdf.js implements `getTextContent()` as `for await (const chunk of stream)`. Async
 * iteration over a `ReadableStream` is not implemented in Safari — it is a Chrome and
 * Firefox extension that never shipped in WebKit — so on an iPhone that line throws
 * "undefined is not a function" and every PDF fails at the first page. Nothing about the
 * PDF is at fault, and no amount of retrying helps.
 *
 * The underlying `streamTextContent()` returns an ordinary reader, which works
 * everywhere. Pulling the chunks by hand and assembling them exactly as pdf.js would
 * gives an identical result on every browser.
 *
 * Falls back to the built-in method where the manual route is unavailable, so a future
 * pdf.js that changes this API degrades rather than breaks.
 */
async function readTextContent(page) {
  if (typeof page.streamTextContent !== 'function') {
    return page.getTextContent();
  }

  const stream = page.streamTextContent({ disableNormalization: true });
  const reader = stream?.getReader?.();

  if (!reader) return page.getTextContent();

  const content = { items: [], styles: Object.create(null), lang: null };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      // push(...items) can overflow the stack on a page with very many runs.
      for (const item of value.items) content.items.push(item);
    }
  } finally {
    reader.releaseLock?.();
  }

  return content;
}

/**
 * The images a PDF page actually contains, at the resolution they were embedded.
 *
 * A barcode occupying 3 cm of an A4 page is a small fraction of a full-page render, and
 * detail is lost before the decoder ever sees it — which is why airline PDFs with a
 * perfectly good QR were reported as having none. pdf.js can hand over the image objects
 * themselves, exactly as the airline placed them, and those decode far more readily.
 *
 * Only plausible barcode shapes are kept: something square-ish or a wide stripe, big
 * enough to carry data. A logo or a photograph is neither, and trying every image on a
 * page would be slow on a phone for no gain.
 */
async function extractPageImages(page, { limit = 8 } = {}) {
  const found = [];

  let operators;
  try {
    operators = await page.getOperatorList();
  } catch {
    return found;
  }

  const { OPS } = await loadPdfjs();
  const names = new Set();

  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i];
    if (op !== OPS.paintImageXObject && op !== OPS.paintJpegXObject) continue;
    const name = operators.argsArray[i]?.[0];
    if (typeof name === 'string') names.add(name);
  }

  for (const name of names) {
    if (found.length >= limit) break;

    let image;
    try {
      // Newer pdf.js resolves images through a callback; older returns them directly.
      image = page.objs.has?.(name)
        ? page.objs.get(name)
        : await new Promise((resolve) => {
          try { page.objs.get(name, resolve); } catch { resolve(null); }
        });
    } catch {
      continue;
    }

    if (!image?.width || !image?.height) continue;

    const { width, height } = image;
    const ratio = width / height;

    // Too small to hold a payload, or too elongated to be anything but a rule or border.
    if (width < 60 || height < 24) continue;
    if (ratio > 12 || ratio < 0.08) continue;

    const canvas = imageToCanvasSource(image);
    if (canvas) found.push({ canvas, scale: 1, region: null, native: true });
  }

  return found;
}

/**
 * Draws a pdf.js image object onto a canvas the decoder can read.
 *
 * pdf.js hands back either a bitmap it has already decoded or raw pixel data, and the
 * shape differs between versions, so both are handled.
 */
function imageToCanvasSource(image) {
  try {
    const canvas = makeCanvas(image.width, image.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (image.bitmap) {
      context.drawImage(image.bitmap, 0, 0);
      return canvas;
    }

    if (!image.data) return null;

    const expected = image.width * image.height * 4;
    const pixels = context.createImageData(image.width, image.height);

    if (image.data.length === expected) {
      pixels.data.set(image.data);
    } else if (image.data.length === image.width * image.height * 3) {
      // RGB without alpha.
      for (let i = 0, j = 0; i < image.data.length; i += 3, j += 4) {
        pixels.data[j] = image.data[i];
        pixels.data[j + 1] = image.data[i + 1];
        pixels.data[j + 2] = image.data[i + 2];
        pixels.data[j + 3] = 255;
      }
    } else if (image.data.length === image.width * image.height) {
      // Greyscale, which is what most barcodes are stored as.
      for (let i = 0, j = 0; i < image.data.length; i++, j += 4) {
        pixels.data[j] = image.data[i];
        pixels.data[j + 1] = image.data[i];
        pixels.data[j + 2] = image.data[i];
        pixels.data[j + 3] = 255;
      }
    } else {
      return null;
    }

    context.putImageData(pixels, 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

/**
 * pdf.js reports text as many small runs with their own transform matrices. We keep
 * each run's bounding box because the review UI highlights the exact region a field
 * came from — that visual link is what makes verification quick rather than tedious.
 */
function normaliseTextItems(textContent, viewport) {
  const items = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = item.transform;
    const x = tx[4];
    const y = tx[5];
    const height = Math.hypot(tx[2], tx[3]) || item.height || 0;
    const width = item.width || Math.hypot(tx[0], tx[1]) * item.str.length;

    // pdf.js origin is bottom-left; the DOM overlay we draw on top is top-left.
    items.push({
      text: item.str,
      x,
      y: viewport.height - y - height,
      width,
      height,
      fontName: item.fontName,
      // A run flagged EOL ends a visual line, which matters when regrouping columns.
      endsLine: Boolean(item.hasEOL),
    });
  }
  return items;
}

/**
 * Decides whether a PDF page carries genuine text or is a wrapped scan.
 *
 * A PDF exported from a photo parses without error and returns an empty or near-empty
 * text layer. Left undetected, the user sees a blank form and assumes the tool is
 * broken. Density is measured per unit area so a sparse-but-real ticket (which is
 * normal — tickets are mostly whitespace) is not mistaken for a scan.
 */
function assessTextLayer(items, viewport) {
  const characters = items.reduce((sum, item) => sum + item.text.trim().length, 0);
  const areaCm2 = (viewport.width * viewport.height) / (72 * 72) * 6.4516;
  const density = areaCm2 > 0 ? characters / areaCm2 : 0;

  // A genuine ticket page carries well over 100 characters even when sparsely laid out.
  const hasText = characters >= 40 && density >= 0.5;

  return {
    characters,
    density: Number(density.toFixed(2)),
    hasText,
    // Some PDFs carry a thin text layer (a header only) over a scanned body.
    partial: hasText && characters < 120,
  };
}

async function renderPageToBitmap(page, scale) {
  const base = page.getViewport({ scale: 1 });
  const safeScale = clampScale(base.width, base.height, scale);
  const viewport = page.getViewport({ scale: safeScale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d', { willReadFrequently: true });

  await page.render({ canvasContext: context, viewport, intent: 'display' }).promise;

  return { canvas, context, viewport, scale: safeScale };
}

async function ingestPdf(file, { onProgress } = {}) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());

  let doc;
  let loadingTask;
  try {
    loadingTask = pdfjs.getDocument({
      data,
      // Tickets occasionally ship with an owner password but no user password;
      // those still open for reading.
      password: '',
      isEvalSupported: false,
      disableFontFace: false,
    });
    doc = await loadingTask.promise;
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new IngestError('This PDF is password protected.', {
        cause: error,
        hint: 'Open it in a PDF reader, remove the password, and try again. Nothing is uploaded — the file stays on your device.',
      });
    }
    throw new IngestError('This file could not be read as a PDF.', { cause: error });
  }

  const pageCount = doc.numPages;
  const pages = [];
  // Multi-page tickets put the pass on page 1 almost without exception; the rest is
  // terms and conditions. Scanning every page of a long PDF wastes time on mobile.
  const pagesToRead = Math.min(pageCount, 3);

  for (let index = 1; index <= pagesToRead; index++) {
    onProgress?.({ phase: 'pdf-page', page: index, of: pagesToRead });
    const page = await doc.getPage(index);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await readTextContent(page);
    const items = normaliseTextItems(textContent, viewport);
    const assessment = assessTextLayer(items, viewport);

    pages.push({
      index,
      page,
      viewport,
      items,
      assessment,
      width: viewport.width,
      height: viewport.height,
    });
  }

  const textPage = pages.find((p) => p.assessment.hasText);
  const primary = textPage || pages[0];
  if (!primary) throw new IngestError('This PDF appears to have no pages.');

  const kind = primary.assessment.hasText ? SourceKind.PDF_TEXT : SourceKind.PDF_SCANNED;

  onProgress?.({ phase: 'render' });
  const rendered = await renderPageToBitmap(primary.page, BARCODE_RENDER_SCALE);
  const display = BARCODE_RENDER_SCALE === DISPLAY_RENDER_SCALE
    ? rendered
    : await renderPageToBitmap(primary.page, DISPLAY_RENDER_SCALE);

  // The page's own images first, at the resolution they were embedded, then the whole
  // page as a fallback. A barcode is a small part of an A4 sheet, and decoding it from a
  // full-page render throws away most of the detail that makes it readable.
  //
  // Tiles last. Several airlines draw a barcode with vector operators rather than
  // placing it as an image, so it appears in neither list — an IndiGo itinerary printing
  // four plainly visible barcodes was reported as carrying none. Cutting the page up is
  // the only way to reach those, and it is tried only once the cheaper paths have failed.
  const embedded = await extractPageImages(primary.page).catch(() => []);
  const barcodeCandidates = [
    ...embedded,
    // Flagged as the whole page rather than a barcode. It is a decoding fallback only:
    // something has to be handed to the decoder when nothing smaller was found. It must
    // never be *kept* as the picture of a barcode, because it is a picture of the ticket.
    { canvas: rendered.canvas, scale: rendered.scale, region: null, wholePage: true },
    ...tileCandidates(rendered.canvas),
  ];

  return {
    kind,
    fileName: file.name,
    fileType: file.type || 'application/pdf',
    pageCount,
    pageIndex: primary.index,
    width: primary.width,
    height: primary.height,
    textItems: primary.items,
    textAssessment: primary.assessment,
    /** High-resolution canvas for barcode decoding. */
    barcodeCanvas: rendered.canvas,
    barcodeScale: rendered.scale,
    /** The page's own images, tried before the full-page render. */
    barcodeCandidates,
    /** Lower-resolution canvas for on-screen display and region highlighting. */
    displayCanvas: display.canvas,
    displayScale: display.scale,
    /** Pages we parsed but did not select, kept so the user can switch pages. */
    otherPages: pages.filter((p) => p.index !== primary.index).map((p) => ({
      index: p.index,
      assessment: p.assessment,
    })),
    needsOcr: !primary.assessment.hasText,

    // Releasing the parser must never be able to fail the ingestion it has already
    // finished. This threw "doc.destroy is not a function" *after* a ticket had been
    // read perfectly, and the failure handler discarded the result and showed the user
    // a raw library message — losing a correctly parsed ticket to a tidying-up step.
    //
    // Which object owns `destroy` has moved between pdf.js versions, so both are tried.
    cleanup: () => {
      try {
        if (typeof doc?.destroy === 'function') doc.destroy();
        else if (typeof loadingTask?.destroy === 'function') loadingTask.destroy();
        else if (typeof doc?.cleanup === 'function') doc.cleanup();
      } catch (error) {
        console.warn('Releasing the PDF parser failed; continuing.', error);
      }
    },
  };
}

/**
 * HEIC has no browser-native decoder outside Safari. Rather than ship a converter,
 * we detect it and tell the user precisely what to do — a 2 MB dependency to handle
 * a format their own phone can export as JPEG is a poor trade against the
 * "nothing leaves your device, and the page stays light" promise.
 */
function isProbablyHeic(file) {
  return /\.hei[cf]$/i.test(file.name) || /image\/hei[cf]/i.test(file.type || '');
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path, which handles a few formats createImageBitmap rejects.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'sync';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('decode failed'));
      image.src = url;
    });
    return image;
  } finally {
    // Revoking immediately is safe: the bitmap has already been decoded into memory.
    URL.revokeObjectURL(url);
  }
}

async function ingestImage(file, { onProgress } = {}) {
  onProgress?.({ phase: 'decode-image' });

  let bitmap;
  try {
    bitmap = await decodeImage(file);
  } catch (error) {
    if (isProbablyHeic(file)) {
      throw new IngestError('This looks like a HEIC image, which this browser cannot open.', {
        cause: error,
        hint: 'On iPhone, share the photo and choose "Most Compatible", or take a screenshot of it — screenshots are always JPEG or PNG.',
      });
    }
    throw new IngestError('This image could not be opened.', { cause: error });
  }

  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  if (!width || !height) throw new IngestError('This image appears to be empty.');

  // Screenshots arrive at wildly different resolutions. Upscaling a small one improves
  // both barcode decoding and OCR; downscaling a huge one keeps mobile memory sane.
  const targetLongEdge = 2400;
  const longEdge = Math.max(width, height);
  const scale = clampScale(width, height, Math.min(3, Math.max(1, targetLongEdge / longEdge)));

  const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  if (typeof bitmap.close === 'function') bitmap.close();

  return {
    kind: SourceKind.IMAGE,
    fileName: file.name,
    fileType: file.type || 'image/*',
    pageCount: 1,
    pageIndex: 1,
    width,
    height,
    textItems: [],
    textAssessment: { characters: 0, density: 0, hasText: false, partial: false },
    barcodeCanvas: canvas,
    barcodeScale: scale,
    // A screenshot has no embedded images — it *is* one image — so the whole picture is
    // the only candidate unless it is cut up. A QR occupying a corner of a phone
    // screenshot is exactly the case a full-frame decode loses.
    barcodeCandidates: [
      { canvas, scale, region: null },
      ...tileCandidates(canvas),
    ],
    displayCanvas: canvas,
    displayScale: scale,
    otherPages: [],
    needsOcr: true,
    cleanup: () => {},
  };
}

// ───────────────────────────── email ─────────────────────────────

/** Trust ceiling for values read out of a laid-out email body. */
const EMAIL_TEXT_ASSESSMENT = { characters: 0, density: 0, hasText: true, partial: false };

/**
 * Builds the barcode candidate list for a laid-out message.
 *
 * Unlike a PDF, where one page canvas contains everything, an email's barcode is a
 * discrete image among a dozen decorative ones. Each is drawn to its own canvas so the
 * decoder works on clean, tightly-cropped pixels — which decodes far more reliably
 * than a screenshot of the whole message, and is much faster besides.
 */
function buildEmailBarcodeCandidates(images) {
  const candidates = [];
  for (const image of rankBarcodeCandidates(images)) {
    // Below this the image is decoration, not a barcode; trying it wastes a second
    // of the user's time for no realistic chance of a hit.
    if (image.barcodeScore < 10) continue;
    const drawn = imageToCanvas(image, { scale: image.naturalWidth < 400 ? 3 : 2 });
    if (!drawn) continue;
    candidates.push({
      canvas: drawn.canvas,
      scale: drawn.scale,
      score: image.barcodeScore,
      region: { x: image.x, y: image.y, width: image.width, height: image.height },
      alt: image.alt,
    });
    if (candidates.length >= 6) break;
  }
  return candidates;
}

/**
 * Describes barcodes we can see but cannot read, so the UI can offer a real choice.
 *
 * A remote barcode is the one case where the privacy promise and the user's goal pull
 * against each other. Rather than resolve that silently in either direction, we hand
 * the user the facts: this image lives on the sender's server, fetching it tells them
 * you opened the mail, and saving it from your mail app avoids that entirely.
 */
function describeUnavailableImages(images) {
  return images
    .filter((image) => image.state === 'remote' || image.state === 'missing')
    .filter((image) => !/logo|icon|banner|facebook|twitter|instagram|app[-_]?store|google[-_]?play|pixel|spacer|track/i.test(`${image.alt} ${image.remoteUrl || ''}`))
    .map((image) => ({
      url: image.remoteUrl,
      alt: image.alt,
      state: image.state,
      width: image.width,
      height: image.height,
      reason: image.state === 'remote'
        ? 'This image is stored on the sender’s server and was not downloaded.'
        : 'This image was not included when the message was copied.',
    }));
}

async function ingestEmailHtml(html, message, { onProgress, fileName, fileType } = {}) {
  onProgress?.({ phase: 'email-layout' });

  const layout = await layoutHtml(html, { resources: message?.resources || new Map() });
  const candidates = buildEmailBarcodeCandidates(layout.images);

  return {
    kind: SourceKind.EMAIL_HTML,
    fileName: fileName || message?.subject || 'Email',
    fileType: fileType || 'message/rfc822',
    pageCount: 1,
    pageIndex: 1,
    width: layout.width,
    height: layout.height,
    textItems: layout.textItems,
    textAssessment: {
      ...EMAIL_TEXT_ASSESSMENT,
      characters: layout.textItems.reduce((sum, item) => sum + item.text.length, 0),
    },
    /** Best-guess barcode image; the rest are tried in order if it yields nothing. */
    barcodeCanvas: candidates[0]?.canvas || null,
    barcodeScale: candidates[0]?.scale || 1,
    barcodeCandidates: candidates,
    /** Email is rendered live rather than rasterised, so highlighting targets the frame. */
    displayCanvas: null,
    displayFrame: layout.frame,
    displayDocument: layout.document,
    displayScale: 1,
    otherPages: [],
    // The body is real text, so OCR is only needed if the ticket turns out to be an
    // image of a ticket pasted into the message — checked once adapters have run.
    needsOcr: false,
    unavailableImages: describeUnavailableImages(layout.images),
    email: message ? summariseMessage(message) : null,
    providerHint: message ? providerFromSender(message) : null,
    cleanup: layout.cleanup,
  };
}

function ingestEmailText(text, message, { fileName, fileType } = {}) {
  const items = itemsFromPlainText(text);
  const lineCount = text.split(/\n/).length;

  return {
    kind: SourceKind.EMAIL_TEXT,
    fileName: fileName || message?.subject || 'Email',
    fileType: fileType || 'text/plain',
    pageCount: 1,
    pageIndex: 1,
    width: 760,
    height: lineCount * 16,
    textItems: items,
    textAssessment: { characters: text.replace(/\s/g, '').length, density: 1, hasText: true, partial: false },
    barcodeCanvas: null,
    barcodeScale: 1,
    barcodeCandidates: [],
    displayCanvas: null,
    displayText: text,
    displayScale: 1,
    otherPages: [],
    needsOcr: false,
    unavailableImages: [],
    email: message ? summariseMessage(message) : null,
    providerHint: message ? providerFromSender(message) : null,
    cleanup: () => {},
  };
}

function summariseMessage(message) {
  return {
    subject: message.subject,
    from: message.from,
    fromName: message.fromName,
    fromDomain: message.fromDomain,
    date: message.date,
    attachments: message.attachments.map(({ name, contentType, size }) => ({ name, contentType, size })),
  };
}

/**
 * Reads a saved message.
 *
 * A ticket mail with a PDF attached is really a PDF ticket in an envelope, so the
 * attachment is preferred over the body — it is the authoritative document, and the
 * body is usually a marketing restatement of it. The envelope's sender still travels
 * with the result as a provider hint, which is a better brand signal than anything in
 * the body text.
 */
async function ingestMessage(rawText, file, options = {}) {
  const message = parseMessage(rawText);

  const attachment = message.attachments.find((a) => a.contentType === 'application/pdf') || message.attachments[0];
  if (attachment) {
    options.onProgress?.({ phase: 'email-attachment', name: attachment.name });
    const inner = await ingest(attachment.file, { ...options, fromEmail: true });
    inner.email = summariseMessage(message);
    inner.providerHint = inner.providerHint || providerFromSender(message);
    inner.envelopeFileName = file?.name || null;
    return inner;
  }

  if (message.html) {
    return ingestEmailHtml(message.html, message, {
      ...options,
      fileName: file?.name || message.subject,
      fileType: file?.type || 'message/rfc822',
    });
  }

  if (message.text) {
    return ingestEmailText(message.text, message, {
      fileName: file?.name || message.subject,
      fileType: file?.type || 'message/rfc822',
    });
  }

  throw new IngestError('This message has no readable body.', {
    hint: 'If the ticket was an attachment, open the message and drop the attachment here instead.',
  });
}

/**
 * Reads a pasted or dropped email body.
 *
 * This is the shortest path for the user by a wide margin: select the mail, copy,
 * paste. No export, no saving, no hunting through a share sheet. It is also the least
 * reliable, because clipboard HTML frequently loses inline images — hence the
 * unavailable-image reporting, which turns a silent failure into a clear next step.
 */
export async function ingestHtml(html, options = {}) {
  return ingestEmailHtml(html, null, { ...options, fileName: options.fileName || 'Pasted message', fileType: 'text/html' });
}

export async function ingestText(text, options = {}) {
  if (looksLikeMessage(text)) return ingestMessage(text, null, options);
  if (looksLikeHtml(text)) return ingestHtml(text, options);
  return ingestEmailText(text, null, { fileName: options.fileName || 'Pasted text', fileType: 'text/plain' });
}

/**
 * Handles a paste or drop event's payload.
 *
 * Order matters. A file always beats markup, because a pasted screenshot arrives as
 * both a file and an <img> tag pointing at a local path we cannot read. HTML beats
 * plain text, because the plain-text flavour of a mail body is the same content with
 * its layout — and therefore its column meaning — discarded.
 */
export async function ingestFromDataTransfer(dataTransfer, options = {}) {
  if (!dataTransfer) throw new IngestError('There was nothing to read.');

  const files = [...(dataTransfer.files || [])];
  if (files.length) return ingest(files[0], options);

  for (const item of [...(dataTransfer.items || [])]) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) return ingest(file, options);
    }
  }

  const html = dataTransfer.getData?.('text/html');
  if (html && html.trim()) return ingestHtml(html, options);

  const text = dataTransfer.getData?.('text/plain');
  if (text && text.trim()) return ingestText(text, options);

  throw new IngestError('Nothing readable was pasted.', {
    hint: 'Select the whole ticket in your mail app before copying, or save it as a PDF and drop it here.',
  });
}

const PDF_MAGIC = '%PDF';

/** Sniffs the actual bytes — a mislabelled or extension-less file is common on mobile. */
async function looksLikePdf(file) {
  const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...header.subarray(0, 4)) === PDF_MAGIC;
}

/**
 * Image formats we will decode, by their opening bytes.
 *
 * Sniffed rather than trusted from the extension or the MIME type, both of which are
 * supplied by whoever made the file. A `.jpg` that is really a ZIP archive is the oldest
 * trick there is.
 *
 * A closed list, and deliberately: everything that reaches this point is handed to the
 * browser's image decoders, which are large C++ libraries with a long history of memory
 * bugs. Anything not recognised here is refused rather than offered up to them, which
 * closes a class of attack rather than any particular instance of it.
 */
const IMAGE_SIGNATURES = [
  // PNG
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], name: 'PNG' },
  // JPEG — any variant, all of which begin with the same marker
  { bytes: [0xff, 0xd8, 0xff], name: 'JPEG' },
  // GIF
  { bytes: [0x47, 0x49, 0x46, 0x38], name: 'GIF' },
  // BMP
  { bytes: [0x42, 0x4d], name: 'BMP' },
];

/**
 * WebP, HEIC and AVIF, which are containers and need a second check.
 *
 * Each carries a four-byte tag at offset 8, after a length field, so the signature is
 * not at the start of the file. HEIC matters especially: it is what an iPhone produces
 * by default, and refusing it would refuse most photographs taken of a printed ticket.
 */
function looksLikeContainerImage(head) {
  const tag = String.fromCharCode(...head.subarray(8, 12));

  // RIFF....WEBP
  if (String.fromCharCode(...head.subarray(0, 4)) === 'RIFF' && tag === 'WEBP') return 'WebP';

  // ....ftypXXXX — ISO base media, which covers HEIC, HEIF and AVIF.
  if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...head.subarray(8, 12));
    if (/^(?:heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/i.test(brand)) return brand.toUpperCase();
  }

  return null;
}

/** The image format, or null if these bytes are not an image we will decode. */
async function imageFormat(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (head.length < 4) return null;

  for (const signature of IMAGE_SIGNATURES) {
    if (signature.bytes.every((byte, index) => head[index] === byte)) return signature.name;
  }

  return looksLikeContainerImage(head);
}

/**
 * The largest file we will open.
 *
 * Not a courtesy limit — a guardrail. Every byte of an added file is attacker-controlled
 * if the "ticket" was emailed by a stranger, and the work done on it is proportional to
 * its size: a PDF is parsed, rendered to a canvas at decoding resolution, tiled, and
 * possibly run through OCR. A large file is therefore a cheap way to exhaust a phone's
 * memory and get the tab killed, which on this app means losing your place at a gate.
 *
 * Eight megabytes is generous against reality. A boarding pass PDF is tens of kilobytes;
 * a hotel voucher a few hundred; a full-page phone screenshot around two megabytes at
 * the worst. Nothing legitimate approaches this, and the previous twenty-five allowed a
 * great deal of work to be demanded before anything was checked.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The largest text-shaped file we will read.
 *
 * Much smaller, and separately, because a text file is decoded to a string in one go and
 * then parsed — a hundred megabytes of newlines is a different kind of expensive from a
 * hundred megabytes of JPEG. An email with a PDF attached is base64 and therefore about
 * a third larger than what it carries, which this still comfortably allows.
 */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

const TEXTUAL_EXTENSION = /\.(eml|mht|mhtml|html?|txt|msg)$/i;
const TEXTUAL_TYPE = /^(message\/|text\/|application\/(mbox|x-mimearchive))/i;

/** A message file is text, so it can simply be read and sniffed for MIME headers. */
async function looksTextual(file) {
  if (TEXTUAL_EXTENSION.test(file.name || '')) return true;
  if (TEXTUAL_TYPE.test(file.type || '')) return true;

  // An extension-less export from a phone: check that the opening bytes are printable.
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (!head.length) return false;
  let printable = 0;
  for (const byte of head) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable++;
  }
  return printable / head.length > 0.95;
}

/**
 * Single entry point. Accepts a File or Blob of any supported type and returns the
 * uniform shape. Throws IngestError with a user-facing hint on failure — never a
 * raw library error, which would be meaningless to the person holding the phone.
 */
export async function ingest(file, options = {}) {
  if (!file) throw new IngestError('No file was provided.');
  if (file.size === 0) throw new IngestError('That file is empty.');
  if (file.size > MAX_FILE_BYTES) {
    throw new IngestError('That file is larger than 25 MB.', {
      hint: 'Tickets are normally well under 1 MB. If this is a photo, a screenshot of it will be much smaller.',
    });
  }

  let result;
  if (await looksLikePdf(file)) {
    result = await ingestPdf(file, options);
  } else if (await looksTextual(file)) {
    if (file.size > MAX_TEXT_BYTES) {
      throw new IngestError('That message is too large to read.', {
        hint: 'Save the ticket itself — the PDF or the image — and add that instead.',
      });
    }

    const text = await file.text();
    if (looksLikeMessage(text)) result = await ingestMessage(text, file, options);
    else if (looksLikeHtml(text)) {
      result = await ingestEmailHtml(text, null, { ...options, fileName: file.name, fileType: file.type || 'text/html' });
    } else if (text.trim()) {
      result = ingestEmailText(text, null, { fileName: file.name, fileType: file.type || 'text/plain' });
    } else {
      throw new IngestError('That file contains no readable text.');
    }
  } else if (await imageFormat(file)) {
    result = await ingestImage(file, options);
  } else {
    /*
     * Anything else is refused, unopened.
     *
     * Everything above is recognised by its opening bytes, not by its name or its
     * declared type — both of which come from whoever made the file. What is left is
     * something we have no reader for, and the previous behaviour was to hand it to the
     * browser's image decoders anyway and see what happened. Those decoders are large
     * C++ libraries with a long history of memory-safety bugs, and feeding them a ZIP
     * archive or an executable in the hope that it might be a JPEG is not a reasonable
     * thing to do with a stranger's file.
     */
    throw new IngestError('That is not a ticket file.', {
      hint: 'Add a PDF, a photo or a screenshot. Those are the only kinds we open.',
    });
  }

  result.sizeBytes = file.size;
  return result;
}

/**
 * Human-readable explanation of what we're about to do, shown in the UI so the user
 * understands why an image takes longer than a PDF instead of assuming it has hung.
 */
export function describeSource(ingested) {
  switch (ingested.kind) {
    case SourceKind.PDF_TEXT:
      return ingested.textAssessment.partial
        ? { label: 'PDF (partial text)', detail: 'Some of this PDF is an image, so a few fields may need checking.' }
        : { label: 'PDF', detail: 'Text read directly from the file — accurate.' };
    case SourceKind.PDF_SCANNED:
      return { label: 'Scanned PDF', detail: 'This PDF contains a picture rather than text, so it will be read visually.' };
    case SourceKind.IMAGE:
      return { label: 'Image', detail: 'Read visually from the picture — please check the details.' };
    case SourceKind.EMAIL_HTML: {
      const missing = ingested.unavailableImages?.length || 0;
      return {
        label: 'Email',
        detail: missing
          ? 'Read from the message. Some images were not downloaded, so the barcode may be missing.'
          : 'Read from the message itself — nothing was downloaded.',
      };
    }
    case SourceKind.EMAIL_TEXT:
      return { label: 'Plain-text email', detail: 'This message has no images, so it carries no barcode.' };
    default:
      return { label: 'File', detail: '' };
  }
}
